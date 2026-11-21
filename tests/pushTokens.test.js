import { describe, it, expect, afterAll, vi } from "vitest";
import { createHash, randomUUID } from "crypto";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";
import { createLoaders } from "../src/dataloaders/index.js";
import db from "../src/config/firestore.js";

const server = new ApolloServer({ typeDefs, resolvers });
const run = async (uid, query, variables) => {
  const response = await server.executeOperation(
    { query, variables },
    { contextValue: { user: { uid }, loaders: createLoaders() } }
  );
  return response.body.singleResult;
};
const errorOf = (result) => result.errors?.[0]?.extensions;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const REGISTER = `mutation ($input: RegisterPushToken!) {
  registerPushToken(input: $input) { code success message }
}`;
const UNREGISTER = `mutation ($input: UnregisterPushToken!) {
  unregisterPushToken(input: $input) { code success message }
}`;

const tokens = [];
const newToken = () => {
  const token = `ExponentPushToken[${randomUUID()}]`;
  tokens.push(token);
  return token;
};
const docOf = (token) =>
  db.collection("pushTokens").doc(createHash("sha256").update(token).digest("hex")).get();
const register = (uid, token, platform = "IOS") => run(uid, REGISTER, { input: { token, platform } });

describe("registerPushToken", () => {
  afterAll(async () => {
    await Promise.all(
      tokens.map((token) =>
        db.collection("pushTokens").doc(createHash("sha256").update(token).digest("hex")).delete()
      )
    );
  });

  it("saves a new token under the signed-in user, keyed by the token's hash", async () => {
    const token = newToken();
    const result = await register("push-user-a", token, "ANDROID");

    expect(result.errors).toBeUndefined();
    expect(result.data.registerPushToken).toEqual({ code: "200", success: true, message: "Push token registered" });
    const doc = await docOf(token);
    expect(doc.data()).toMatchObject({ uid: "push-user-a", token, platform: "ANDROID" });
    expect(doc.get("createdAt").toMillis()).toBe(doc.get("lastSeenAt").toMillis());
  });

  it("registering the same token again within a day writes nothing", async () => {
    const token = newToken();
    await register("push-user-a", token);
    const first = await docOf(token);

    const result = await register("push-user-a", token);

    expect(result.data.registerPushToken.success).toBe(true);
    const second = await docOf(token);
    expect(second.updateTime.isEqual(first.updateTime)).toBe(true);
    const all = await db.collection("pushTokens").where("token", "==", token).get();
    expect(all.size).toBe(1);
  });

  it("refreshes lastSeenAt once it's more than a day old, keeping createdAt", async () => {
    const token = newToken();
    await register("push-user-a", token);
    const ref = db.collection("pushTokens").doc(createHash("sha256").update(token).digest("hex"));
    const old = new Date(Date.now() - 25 * HOUR);
    await ref.update({ createdAt: old, lastSeenAt: old });

    await register("push-user-a", token);

    const doc = await docOf(token);
    expect(doc.get("createdAt").toMillis()).toBe(old.getTime());
    expect(doc.get("lastSeenAt").toMillis()).toBeGreaterThan(Date.now() - HOUR);
  });

  it("updates the platform when it changes", async () => {
    const token = newToken();
    await register("push-user-a", token, "IOS");

    await register("push-user-a", token, "ANDROID");

    expect((await docOf(token)).get("platform")).toBe("ANDROID");
  });

  it("moves a token registered by another user to the one now signed in on the device", async () => {
    const token = newToken();
    await register("push-user-a", token);

    const result = await register("push-user-b", token);

    expect(result.data.registerPushToken.success).toBe(true);
    expect((await docOf(token)).get("uid")).toBe("push-user-b");
  });

  it("parallel registrations of one token all succeed, with no CONFLICT", async () => {
    const token = newToken();

    const results = await Promise.all(Array.from({ length: 20 }, () => register("push-user-a", token)));

    expect(results.map((result) => result.errors)).toEqual(Array(20).fill(undefined));
    expect((await docOf(token)).get("uid")).toBe("push-user-a");
  });

  it("keeps a token that keeps changing user under its current one, and logs it without the token", async () => {
    const token = newToken();
    await register("push-user-a", token);
    for (const uid of ["push-user-b", "push-user-a", "push-user-b"]) await register(uid, token);
    const lines = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(...String(chunk).split("\n").filter((line) => line.startsWith("{")));
      return true;
    });

    const result = await register("push-user-a", token);

    vi.restoreAllMocks();
    expect(result.data.registerPushToken.success).toBe(true);
    expect((await docOf(token)).get("uid")).toBe("push-user-b");
    const warnings = lines.map((line) => JSON.parse(line)).filter((entry) => entry.severity === "WARNING");
    expect(warnings).toContainEqual(
      expect.objectContaining({ message: "Push token changed user too often, kept under its current user" })
    );
    expect(lines.join("\n")).not.toContain(token);
  });

  it("lets the token move again once the last changes are older than ten minutes", async () => {
    const token = newToken();
    await register("push-user-a", token);
    for (const uid of ["push-user-b", "push-user-a", "push-user-b"]) await register(uid, token);
    const ref = db.collection("pushTokens").doc(createHash("sha256").update(token).digest("hex"));
    const longAgo = new Date(Date.now() - 11 * MINUTE);
    await ref.update({ ownerChanges: [longAgo, longAgo, longAgo] });

    await register("push-user-a", token);

    expect((await docOf(token)).get("uid")).toBe("push-user-a");
  });

  it("rejects a token that isn't an Expo push token with BAD_USER_INPUT", async () => {
    const result = await register("push-user-a", "not-a-push-token");

    expect(errorOf(result)).toMatchObject({ code: "BAD_USER_INPUT", invalidArgument: "token" });
  });

  it("rejects a platform outside the enum before reaching the service", async () => {
    const result = await run("push-user-a", REGISTER, { input: { token: newToken(), platform: "WEB" } });

    expect(errorOf(result)?.code).toBe("BAD_USER_INPUT");
  });
});

describe("unregisterPushToken", () => {
  it("deletes the signed-in user's own token", async () => {
    const token = newToken();
    await register("push-user-a", token);

    const result = await run("push-user-a", UNREGISTER, { input: { token } });

    expect(result.data.unregisterPushToken).toEqual({ code: "200", success: true, message: "Push token unregistered" });
    expect((await docOf(token)).exists).toBe(false);
  });

  it("answers NOT_FOUND for another user's token and leaves it in place", async () => {
    const token = newToken();
    await register("push-user-a", token);

    const result = await run("push-user-b", UNREGISTER, { input: { token } });

    expect(errorOf(result)).toMatchObject({ code: "NOT_FOUND", invalidArgument: "token" });
    expect((await docOf(token)).get("uid")).toBe("push-user-a");
  });

  it("answers NOT_FOUND for a token that was never registered", async () => {
    const result = await run("push-user-a", UNREGISTER, { input: { token: newToken() } });

    expect(errorOf(result)).toMatchObject({ code: "NOT_FOUND", invalidArgument: "token" });
  });
});
