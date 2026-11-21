import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { createHash, randomUUID } from "crypto";
import request from "supertest";
import { RateLimiter, BoundedMap } from "../src/rateLimit/limiter.js";
import { QUARANTINE_AFTER_REJECTIONS, QUARANTINE_MS } from "../src/rateLimit/limits.js";

// The bearer token is the uid, so each test can be any user it needs.
vi.mock("../src/auth/verifyIdToken.js", () => ({
  verifyIdToken: vi.fn(async (header) => ({ uid: header?.slice("Bearer ".length) || "rate-limit-user" })),
}));

const db = (await import("../src/config/firestore.js")).default;
const { createApp } = await import("../src/app.js");


describe("RateLimiter", () => {
  const clock = () => {
    let now = 1_000_000;
    return { now: () => now, advance: (ms) => (now += ms) };
  };

  it("lets a user's budget through, then rejects with how long to wait, and refills", () => {
    const time = clock();
    const limiter = new RateLimiter({ now: time.now });
    const call = () => limiter.check({ uid: "user-a", ip: "203.0.113.1", operationClass: "pushToken" });

    expect([call(), call(), call()].every((decision) => decision.allowed)).toBe(true);
    expect(call()).toEqual({ allowed: false, retryAfterSeconds: 20 });

    time.advance(20 * 1000);
    expect(call().allowed).toBe(true);
  });

  it("keeps separate budgets per class of operation", () => {
    const limiter = new RateLimiter({ now: clock().now });
    for (let i = 0; i < 3; i++) limiter.check({ uid: "user-a", ip: "203.0.113.1", operationClass: "pushToken" });

    expect(limiter.check({ uid: "user-a", ip: "203.0.113.1", operationClass: "query" }).allowed).toBe(true);
  });

  it("limits an IP that rotates users", () => {
    const limiter = new RateLimiter({ now: clock().now });
    const decisions = Array.from({ length: 13 }, (_, i) =>
      limiter.check({ uid: `rotated-${i}`, ip: "203.0.113.9", operationClass: "pushToken" })
    );

    // 3 per minute per user, times 4 per IP.
    expect(decisions.slice(0, 12).every((decision) => decision.allowed)).toBe(true);
    expect(decisions[12].allowed).toBe(false);
  });

  it("quarantines a user that keeps exceeding its budget, without affecting other users or IPs", () => {
    const time = clock();
    const limiter = new RateLimiter({ now: time.now });
    const looping = () => limiter.check({ uid: "looping", ip: "203.0.113.1", operationClass: "pushToken" });
    for (let i = 0; i < 3; i++) looping();
    const rejections = Array.from({ length: QUARANTINE_AFTER_REJECTIONS }, looping);

    expect(rejections.at(-1)).toEqual({
      allowed: false,
      retryAfterSeconds: QUARANTINE_MS / 1000,
      quarantined: { scope: "user", id: "looping" },
    });
    // Every class is rejected during the quarantine.
    expect(limiter.check({ uid: "looping", ip: "203.0.113.1", operationClass: "query" }).allowed).toBe(false);
    // Another user, on the same IP or another one, isn't.
    expect(limiter.check({ uid: "other", ip: "203.0.113.1", operationClass: "pushToken" }).allowed).toBe(true);
    expect(limiter.check({ uid: "other", ip: "198.51.100.1", operationClass: "pushToken" }).allowed).toBe(true);

    time.advance(QUARANTINE_MS + 1);
    expect(looping().allowed).toBe(true);
  });

  it("keeps a bounded number of keys whatever the number of users", () => {
    const map = new BoundedMap(100);
    for (let i = 0; i < 1000; i++) map.set(`key-${i}`, i);

    expect(map.size).toBe(100);
    expect(map.get("key-0")).toBeUndefined();
    expect(map.get("key-999")).toBe(999);
  });
});

describe("rate limiting on /graphql", () => {
  const REGISTER = `mutation Register($input: RegisterPushToken!) {
    registerPushToken(input: $input) { code success }
  }`;
  const tokens = [];
  const servers = [];

  const newApp = async () => {
    const created = await createApp();
    servers.push(created.httpServer);
    return created.app;
  };
  const register = (app, uid, token, ip = "203.0.113.50") =>
    request(app)
      .post("/graphql")
      .set("Authorization", `Bearer ${uid}`)
      .set("X-Forwarded-For", ip)
      .send({ query: REGISTER, variables: { input: { token, platform: "IOS" } } });
  const newToken = () => {
    const token = `ExponentPushToken[${randomUUID()}]`;
    tokens.push(token);
    return token;
  };
  // Every way the API reaches Firestore goes through these.
  const spyOnFirestore = () =>
    ["collection", "doc", "collectionGroup", "runTransaction", "batch", "getAll"].map((method) =>
      vi.spyOn(db, method)
    );

  afterEach(() => {
    vi.restoreAllMocks();
    servers.splice(0).forEach((server) => server.close());
  });

  afterAll(async () => {
    await Promise.all(
      tokens.map((token) => db.collection("pushTokens").doc(createHash("sha256").update(token).digest("hex")).delete())
    );
  });

  it("answers RATE_LIMITED with HTTP 429 and Retry-After, without touching Firestore", async () => {
    const app = await newApp();
    const uid = `limited-${randomUUID()}`;
    for (let i = 0; i < 3; i++) await register(app, uid, newToken());
    const spies = spyOnFirestore();

    const response = await register(app, uid, newToken());

    expect(response.status).toBe(429);
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    expect(response.body.errors[0].extensions).toEqual({
      code: "RATE_LIMITED",
      retryAfter: Number(response.headers["retry-after"]),
    });
    expect(response.body.data).toBeUndefined();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("runs two identical requests in flight once", async () => {
    const app = await newApp();
    const uid = `parallel-${randomUUID()}`;
    const token = newToken();
    const collection = vi.spyOn(db, "collection");

    const [first, second] = await Promise.all([register(app, uid, token), register(app, uid, token)]);

    expect(first.body).toEqual(second.body);
    expect(first.body.data.registerPushToken.success).toBe(true);
    expect(collection.mock.calls.filter(([name]) => name === "pushTokens")).toHaveLength(1);
  });

  it("answers an idempotent repeat from memory", async () => {
    const app = await newApp();
    const uid = `repeat-${randomUUID()}`;
    const token = newToken();
    await register(app, uid, token);
    const spies = spyOnFirestore();

    const response = await register(app, uid, token);

    expect(response.status).toBe(200);
    expect(response.body.data.registerPushToken.success).toBe(true);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("logs the quarantine without variables, tokens or the full uid and IP", async () => {
    const app = await newApp();
    const uid = `quarantined-${randomUUID()}`;
    const token = newToken();
    const lines = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(...String(chunk).split("\n").filter((line) => line.startsWith("{")));
      return true;
    });

    // Different tokens, so neither single-flight nor the replay answers them.
    for (let i = 0; i < 3 + QUARANTINE_AFTER_REJECTIONS; i++) {
      await register(app, uid, i === 0 ? token : newToken(), "203.0.113.77");
    }

    const warnings = lines.map((line) => JSON.parse(line)).filter((entry) => entry.message === "Rate limit quarantine started");
    expect(warnings).toEqual([
      expect.objectContaining({
        severity: "WARNING",
        scope: "user",
        uid: uid.slice(0, 8),
        operationClass: "pushToken",
        operationName: "Register",
      }),
    ]);
    const logs = lines.join("\n");
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(uid);
    expect(logs).not.toContain("203.0.113.77");
  });

  it("reads the client's IP from X-Forwarded-For, so another IP isn't limited", async () => {
    const app = await newApp();
    for (let i = 0; i < 12; i++) await register(app, `ip-a-${randomUUID()}`, newToken(), "203.0.113.90");

    const sameIp = await register(app, `ip-a-${randomUUID()}`, newToken(), "203.0.113.90");
    const otherIp = await register(app, `ip-b-${randomUUID()}`, newToken(), "198.51.100.90");

    expect(sameIp.status).toBe(429);
    expect(otherIp.status).toBe(200);
  });

  it("leaves /healthcheck and the Stripe webhook outside the limiter", async () => {
    const app = await newApp();

    const health = await Promise.all(Array.from({ length: 200 }, () => request(app).get("/healthcheck")));
    const webhooks = await Promise.all(
      Array.from({ length: 50 }, () =>
        request(app).post("/webhooks/stripe").set("Content-Type", "application/json").send("{}")
      )
    );

    expect(health.every((response) => response.status === 200)).toBe(true);
    expect(webhooks.some((response) => response.status === 429)).toBe(false);
  });
});

