import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { createHash, randomUUID } from "crypto";
import request from "supertest";
import db from "../src/config/firestore.js";
import { registerPushToken } from "../src/db/pushTokens.js";

const WEBHOOK_SECRET = "whsec_push_test_secret";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

// Only Stripe's crypto is real, to sign the events.
vi.mock("../src/config/stripe.js", async () => {
  const Stripe = (await import("stripe")).default;
  return { default: new Stripe("sk_test_fake_key_for_webhook_crypto_only") };
});

// The real client, so messages are chunked as in production; only the send
// to Expo's servers is simulated.
vi.mock("../src/config/expo.js", async () => {
  const { Expo } = await import("expo-server-sdk");
  const client = new Expo();
  client.sendPushNotificationsAsync = vi.fn();
  return { default: client };
});

const stripeClient = (await import("../src/config/stripe.js")).default;
const expoClient = (await import("../src/config/expo.js")).default;
const { createApp } = await import("../src/app.js");
const { app } = await createApp();

const okTickets = (messages) => messages.map(() => ({ status: "ok", id: `ticket-${randomUUID()}` }));

const deliver = async (type, object) => {
  const payload = JSON.stringify({ id: `evt_${randomUUID()}`, type, data: { object } });
  const signature = stripeClient.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return (
    await request(app)
      .post("/webhooks/stripe")
      .set("stripe-signature", signature)
      .set("Content-Type", "application/json")
      .send(payload)
  ).status;
};

const orderIds = [];
const tokens = [];
const tokenDoc = (token) => db.collection("pushTokens").doc(createHash("sha256").update(token).digest("hex"));

const deviceOf = async (uid) => {
  const token = `ExponentPushToken[${randomUUID()}]`;
  tokens.push(token);
  await registerPushToken({ token, platform: "IOS" }, uid);
  return token;
};

// A PAYMENT_PENDING order of uid, with one item of 100 + 16% tax (116).
const pendingOrder = async (uid) => {
  const docRef = db.collection("orders").doc();
  orderIds.push(docRef.id);
  const paymentId = `pi_${docRef.id}`;
  await docRef.set({ cart: `cart-${docRef.id}`, status: "PAYMENT_PENDING", customer: null, address: null, paymentId, userId: uid });
  await db.collection("cartItems").doc(`item-${docRef.id}`).set({
    cartId: `cart-${docRef.id}`,
    orderId: docRef.id,
    userId: uid,
    productId: "fixture-product",
    quantity: 1,
    unitPrice: 100,
    subtotal: 100,
  });
  return { orderId: docRef.id, paymentId };
};

const paymentSucceeded = ({ orderId, paymentId }) =>
  deliver("payment_intent.succeeded", { id: paymentId, amount_received: 116, metadata: { order_id: orderId } });

const paymentFailed = ({ orderId, paymentId }) =>
  deliver("payment_intent.payment_failed", {
    id: paymentId,
    amount: 116,
    currency: "mxn",
    last_payment_error: { code: "card_declined", decline_code: "generic_decline" },
    metadata: { order_id: orderId },
  });

const sentMessages = () => expoClient.sendPushNotificationsAsync.mock.calls.flatMap(([messages]) => messages);

const captureErrors = () => {
  const lines = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(...String(chunk).split("\n").filter((line) => line.startsWith("{")));
    return true;
  });
  return () => lines.map((line) => JSON.parse(line));
};

describe("push notifications from the Stripe webhook", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    expoClient.sendPushNotificationsAsync.mockReset();
  });
  afterAll(async () => {
    await Promise.all(orderIds.map((id) => db.collection("orders").doc(id).delete()));
    await Promise.all(orderIds.map((id) => db.collection("cartItems").doc(`item-${id}`).delete()));
    await Promise.all(tokens.map((token) => tokenDoc(token).delete()));
    const tickets = await db.collection("pushTickets").get();
    await Promise.all(tickets.docs.filter((doc) => tokens.includes(doc.get("token"))).map((doc) => doc.ref.delete()));
  });

  it("tells every device of the owner that the order was confirmed, and keeps the tickets", async () => {
    const uid = `push-${randomUUID()}`;
    const [phone, tablet] = [await deviceOf(uid), await deviceOf(uid)];
    await deviceOf(`someone-else-${randomUUID()}`);
    expoClient.sendPushNotificationsAsync.mockImplementation(async (messages) => okTickets(messages));
    const order = await pendingOrder(uid);

    expect(await paymentSucceeded(order)).toBe(200);

    const messages = sentMessages();
    expect(messages.map((message) => message.to).sort()).toEqual([phone, tablet].sort());
    expect(messages[0]).toMatchObject({
      title: "Order confirmed",
      body: "We received your payment.",
      data: { type: "order_completed", orderId: order.orderId, url: `myapp://orders/${order.orderId}` },
      sound: "default",
      priority: "high",
      channelId: "orders",
    });
    const tickets = await db.collection("pushTickets").where("uid", "==", uid).get();
    expect(tickets.docs.map((doc) => doc.get("token")).sort()).toEqual([phone, tablet].sort());
    const ticket = tickets.docs[0].data();
    expect(ticket.expiresAt.toMillis() - ticket.createdAt.toMillis()).toBe(2 * 24 * 60 * 60 * 1000);
  });

  it("notifies only once when the order is completed by a second event", async () => {
    const uid = `push-${randomUUID()}`;
    await deviceOf(uid);
    expoClient.sendPushNotificationsAsync.mockImplementation(async (messages) => okTickets(messages));
    const order = await pendingOrder(uid);

    expect(await paymentSucceeded(order)).toBe(200);
    expect(await paymentSucceeded(order)).toBe(200);

    expect(expoClient.sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
  });

  it("tells the owner that the payment was declined", async () => {
    const uid = `push-${randomUUID()}`;
    const phone = await deviceOf(uid);
    expoClient.sendPushNotificationsAsync.mockImplementation(async (messages) => okTickets(messages));
    const order = await pendingOrder(uid);

    expect(await paymentFailed(order)).toBe(200);

    expect(sentMessages()).toEqual([
      expect.objectContaining({
        to: phone,
        title: "Payment failed",
        body: "Your card was declined. Try again from the app.",
        data: { type: "payment_failed", orderId: order.orderId, url: `myapp://orders/${order.orderId}` },
      }),
    ]);
  });

  it("sends nothing to a user without devices", async () => {
    const order = await pendingOrder(`push-${randomUUID()}`);

    expect(await paymentSucceeded(order)).toBe(200);

    expect(expoClient.sendPushNotificationsAsync).not.toHaveBeenCalled();
    expect((await db.collection("orders").doc(order.orderId).get()).get("status")).toBe("COMPLETE");
  });

  it("deletes a token Expo says no longer reaches a device", async () => {
    const uid = `push-${randomUUID()}`;
    const [alive, dead] = [await deviceOf(uid), await deviceOf(uid)];
    expoClient.sendPushNotificationsAsync.mockImplementation(async (messages) =>
      messages.map((message) =>
        message.to === dead
          ? { status: "error", message: `${dead} is not registered`, details: { error: "DeviceNotRegistered" } }
          : { status: "ok", id: `ticket-${randomUUID()}` }
      )
    );

    expect(await paymentSucceeded(await pendingOrder(uid))).toBe(200);

    expect((await tokenDoc(dead).get()).exists).toBe(false);
    expect((await tokenDoc(alive).get()).exists).toBe(true);
    const tickets = await db.collection("pushTickets").where("uid", "==", uid).get();
    expect(tickets.docs.map((doc) => doc.get("token"))).toEqual([alive]);
  });

  it("with Expo down, still completes the order and answers 200, logging the failure", async () => {
    const uid = `push-${randomUUID()}`;
    await deviceOf(uid);
    expoClient.sendPushNotificationsAsync.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const errors = captureErrors();
    const order = await pendingOrder(uid);

    expect(await paymentSucceeded(order)).toBe(200);

    expect((await db.collection("orders").doc(order.orderId).get()).get("status")).toBe("COMPLETE");
    expect(errors()).toContainEqual(
      expect.objectContaining({
        severity: "ERROR",
        message: "Push notification failed",
        type: "order_completed",
        error: "connect ECONNREFUSED",
      })
    );
  });

  it("sends a user with more than 100 devices in chunks of 100", async () => {
    const uid = `push-${randomUUID()}`;
    for (let i = 0; i < 101; i++) await deviceOf(uid);
    expoClient.sendPushNotificationsAsync.mockImplementation(async (messages) => okTickets(messages));

    expect(await paymentSucceeded(await pendingOrder(uid))).toBe(200);

    const sizes = expoClient.sendPushNotificationsAsync.mock.calls.map(([messages]) => messages.length);
    expect(sizes).toEqual([100, 1]);
  });
});
