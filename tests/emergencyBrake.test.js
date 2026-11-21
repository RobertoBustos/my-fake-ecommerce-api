import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { createHash, randomUUID } from "crypto";
import request from "supertest";
import { EmergencyBrake } from "../src/rateLimit/emergencyBrake.js";

// The bearer token is the uid, so each test can be any user it needs.
vi.mock("../src/auth/verifyIdToken.js", () => ({
  verifyIdToken: vi.fn(async (header) => ({ uid: header?.slice("Bearer ".length) || "brake-user" })),
}));

const db = (await import("../src/config/firestore.js")).default;
const { createApp } = await import("../src/app.js");

describe("EmergencyBrake", () => {
  it("reads comma-separated lists and ignores blanks", () => {
    const brake = new EmergencyBrake({ blockedOperations: " registerPushToken, ,Register ", blockedUids: "a,b" });

    expect([...brake.blockedOperations]).toEqual(["registerPushToken", "Register"]);
    expect([...brake.blockedUids]).toEqual(["a", "b"]);
    expect(brake.engaged).toBe(true);
    expect(new EmergencyBrake().engaged).toBe(false);
  });

  it("blocks by root field or by operation name, and lets the rest through", () => {
    const brake = new EmergencyBrake({ blockedOperations: "registerPushToken,Checkout" });

    expect(brake.check({ uid: "u", operationName: "Any", rootFields: ["registerPushToken"] })?.extensions.code).toBe(
      "SERVICE_UNAVAILABLE"
    );
    expect(brake.check({ uid: "u", operationName: "Checkout", rootFields: ["createOrderPayment"] })?.extensions.code).toBe(
      "SERVICE_UNAVAILABLE"
    );
    expect(brake.check({ uid: "u", operationName: "Cart", rootFields: ["cart"] })).toBeUndefined();
  });
});

describe("emergency brake on /graphql", () => {
  const REGISTER = `mutation Register($input: RegisterPushToken!) {
    registerPushToken(input: $input) { code success }
  }`;
  const tokens = [];
  const servers = [];
  const env = { ...process.env };

  // The brake is read once, when the app starts.
  const newApp = async (vars = {}) => {
    Object.assign(process.env, vars);
    const created = await createApp();
    servers.push(created.httpServer);
    return created.app;
  };
  const register = (app, uid) => {
    const token = `ExponentPushToken[${randomUUID()}]`;
    tokens.push(token);
    return request(app)
      .post("/graphql")
      .set("Authorization", `Bearer ${uid}`)
      .send({ query: REGISTER, variables: { input: { token, platform: "IOS" } } });
  };
  const spyOnFirestore = () =>
    ["collection", "doc", "collectionGroup", "runTransaction", "batch", "getAll"].map((method) => vi.spyOn(db, method));

  afterEach(() => {
    vi.restoreAllMocks();
    servers.splice(0).forEach((server) => server.close());
    delete process.env.BLOCKED_OPERATIONS;
    delete process.env.BLOCKED_UIDS;
    Object.assign(process.env, env);
  });

  afterAll(async () => {
    await Promise.all(
      tokens.map((token) => db.collection("pushTokens").doc(createHash("sha256").update(token).digest("hex")).delete())
    );
  });

  it("answers a blocked operation with SERVICE_UNAVAILABLE without touching Firestore", async () => {
    const app = await newApp({ BLOCKED_OPERATIONS: "registerPushToken" });
    const spies = spyOnFirestore();

    const response = await register(app, `blocked-op-${randomUUID()}`);

    expect(response.status).toBe(200);
    expect(response.body.errors[0].extensions).toEqual({ code: "SERVICE_UNAVAILABLE", retryable: false });
    expect(response.body.data).toBeUndefined();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("answers a blocked user with FORBIDDEN without touching Firestore, and lets other users through", async () => {
    const blocked = `blocked-uid-${randomUUID()}`;
    const app = await newApp({ BLOCKED_UIDS: `someone-else,${blocked}` });
    const spies = spyOnFirestore();

    const response = await register(app, blocked);

    expect(response.status).toBe(403);
    expect(response.body.errors[0].extensions).toEqual({ code: "FORBIDDEN" });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    const other = await register(app, `free-${randomUUID()}`);
    expect(other.status).toBe(200);
    expect(other.body.data.registerPushToken.success).toBe(true);
  });

  it("goes before the rate limiter: past the budget a blocked user still gets FORBIDDEN, not RATE_LIMITED", async () => {
    const uid = `brake-budget-${randomUUID()}`;
    const app = await newApp({ BLOCKED_UIDS: uid });
    for (let i = 0; i < 5; i++) expect((await register(app, uid)).status).toBe(403);
  });

  it("changes nothing when neither variable is set", async () => {
    const app = await newApp();

    const response = await register(app, `unbraked-${randomUUID()}`);

    expect(response.status).toBe(200);
    expect(response.body.data.registerPushToken.success).toBe(true);
  });

  it("logs that it's engaged at startup, with the operations but without the uids", async () => {
    const lines = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(...String(chunk).split("\n").filter((line) => line.startsWith("{")));
      return true;
    });

    await newApp({ BLOCKED_OPERATIONS: "registerPushToken", BLOCKED_UIDS: "secret-uid-1,secret-uid-2" });

    const entries = lines.map((line) => JSON.parse(line)).filter((entry) => entry.message === "Emergency brake engaged");
    expect(entries).toEqual([
      expect.objectContaining({ severity: "WARNING", blockedOperations: ["registerPushToken"], blockedUids: 2 }),
    ]);
    expect(lines.join("\n")).not.toContain("secret-uid");
  });
});
