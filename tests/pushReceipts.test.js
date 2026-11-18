import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash, randomUUID } from "crypto";
import db from "../src/config/firestore.js";
import { registerPushToken } from "../src/db/pushTokens.js";

// Only the request to Expo's servers is simulated.
vi.mock("../src/config/expo.js", async () => {
  const { Expo } = await import("expo-server-sdk");
  const client = new Expo();
  client.getPushNotificationReceiptsAsync = vi.fn();
  return { default: client };
});

const expoClient = (await import("../src/config/expo.js")).default;
const { checkPushReceipts } = await import("../src/services/pushReceipts.js");

const MINUTE = 60 * 1000;
const tokenDoc = (token) => db.collection("pushTokens").doc(createHash("sha256").update(token).digest("hex"));
const ticketDoc = (ticketId) => db.collection("pushTickets").doc(ticketId);

const created = { tickets: [], tokens: [] };

// A ticket sent minutesAgo, for a device registered under a new user.
const ticketSent = async (minutesAgo) => {
  const uid = `receipts-${randomUUID()}`;
  const token = `ExponentPushToken[${randomUUID()}]`;
  const ticketId = `ticket-${randomUUID()}`;
  await registerPushToken({ token, platform: "ANDROID" }, uid);
  const createdAt = new Date(Date.now() - minutesAgo * MINUTE);
  await ticketDoc(ticketId).set({ token, uid, createdAt, expiresAt: new Date(createdAt.getTime() + 2 * 24 * 60 * MINUTE) });
  created.tickets.push(ticketId);
  created.tokens.push(token);
  return { ticketId, token };
};

const receiptsFor = (receipts) =>
  expoClient.getPushNotificationReceiptsAsync.mockImplementation(async (ids) =>
    Object.fromEntries(ids.filter((id) => receipts[id]).map((id) => [id, receipts[id]]))
  );

const exists = async (ref) => (await ref.get()).exists;

describe("checkPushReceipts", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    expoClient.getPushNotificationReceiptsAsync.mockReset();
    await Promise.all(created.tickets.map((id) => ticketDoc(id).delete()));
    await Promise.all(created.tokens.map((token) => tokenDoc(token).delete()));
    created.tickets.length = 0;
    created.tokens.length = 0;
  });

  it("deletes a delivered ticket and keeps its token", async () => {
    const { ticketId, token } = await ticketSent(20);
    receiptsFor({ [ticketId]: { status: "ok" } });

    const counts = await checkPushReceipts();

    expect(counts).toMatchObject({ ok: 1, failed: 0, deadTokens: 0 });
    expect(await exists(ticketDoc(ticketId))).toBe(false);
    expect(await exists(tokenDoc(token))).toBe(true);
  });

  it("deletes the token of a device that is no longer registered", async () => {
    const { ticketId, token } = await ticketSent(20);
    receiptsFor({
      [ticketId]: { status: "error", message: `${token} is not registered`, details: { error: "DeviceNotRegistered" } },
    });

    const counts = await checkPushReceipts();

    expect(counts).toMatchObject({ ok: 0, failed: 1, deadTokens: 1 });
    expect(await exists(tokenDoc(token))).toBe(false);
    expect(await exists(ticketDoc(ticketId))).toBe(false);
  });

  it("logs any other error without the token, and keeps the token", async () => {
    const { ticketId, token } = await ticketSent(20);
    receiptsFor({
      [ticketId]: { status: "error", message: `Bad credentials for ${token}`, details: { error: "InvalidCredentials" } },
    });
    const lines = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(...String(chunk).split("\n").filter((line) => line.startsWith("{")));
      return true;
    });

    const counts = await checkPushReceipts();

    expect(counts).toMatchObject({ failed: 1, deadTokens: 0 });
    const errors = lines.map((line) => JSON.parse(line));
    expect(errors).toContainEqual(
      expect.objectContaining({ severity: "ERROR", message: "Push notification not delivered", error: "InvalidCredentials" })
    );
    expect(lines.join("\n")).not.toContain(token);
    expect(await exists(tokenDoc(token))).toBe(true);
    expect(await exists(ticketDoc(ticketId))).toBe(false);
  });

  it("keeps a ticket whose receipt isn't ready, for the next run", async () => {
    const { ticketId } = await ticketSent(20);
    receiptsFor({});

    const counts = await checkPushReceipts();

    expect(counts).toMatchObject({ pending: 1, ok: 0 });
    expect(await exists(ticketDoc(ticketId))).toBe(true);
  });

  it("doesn't ask for a ticket sent less than 15 minutes ago", async () => {
    const { ticketId } = await ticketSent(5);
    receiptsFor({});

    await checkPushReceipts();

    const asked = expoClient.getPushNotificationReceiptsAsync.mock.calls.flatMap(([ids]) => ids);
    expect(asked).not.toContain(ticketId);
    expect(await exists(ticketDoc(ticketId))).toBe(true);
  });

  it("deletes a ticket older than 24 hours without asking for its receipt", async () => {
    const { ticketId, token } = await ticketSent(25 * 60);
    receiptsFor({});

    const counts = await checkPushReceipts();

    expect(counts).toMatchObject({ expired: 1 });
    const asked = expoClient.getPushNotificationReceiptsAsync.mock.calls.flatMap(([ids]) => ids);
    expect(asked).not.toContain(ticketId);
    expect(await exists(ticketDoc(ticketId))).toBe(false);
    expect(await exists(tokenDoc(token))).toBe(true);
  });

  it("with Expo down, fails the run and keeps the tickets", async () => {
    const { ticketId } = await ticketSent(20);
    expoClient.getPushNotificationReceiptsAsync.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(checkPushReceipts()).rejects.toThrow("ECONNREFUSED");

    expect(await exists(ticketDoc(ticketId))).toBe(true);
  });
});
