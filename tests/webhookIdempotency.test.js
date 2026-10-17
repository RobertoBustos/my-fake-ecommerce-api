import { describe, it, expect, vi, afterAll } from "vitest";
import stripeClient from "../src/config/stripe.js";
import db from "../src/config/firestore.js";
import * as ordersDb from "../src/db/orders.js";
import { createApp } from "../src/app.js";

const WEBHOOK_SECRET = "whsec_test_secret_idempotency";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

// Same reason as in stripeWebhook.test.js: supertest/superagent corrupts a
// Buffer with Content-Type application/json, so we use native fetch
// against a real port to preserve the exact bytes of the signed body.
const postWebhook = async (app, { body, signature }) => {
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/stripe`, {
      method: "POST",
      headers: { "stripe-signature": signature, "Content-Type": "application/json" },
      body,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } finally {
    server.close();
  }
};

describe("Webhook event idempotency", () => {
  let orderId;
  let eventId;

  afterAll(async () => {
    if (orderId) {
      await db.collection("orders").doc(orderId).delete();
      await db.collection("cartItems").doc(`item-${orderId}`).delete();
    }
    if (eventId) {
      await db.collection("processedWebhookEvents").doc(eventId).delete();
    }
  });

  it("the same event delivered twice only applies the effect once", async () => {
    const docRef = db.collection("orders").doc();
    orderId = docRef.id;
    await docRef.set({
      cart: "cart-idempotency-test",
      status: "PAYMENT_PENDING",
      customer: null,
      address: null,
      paymentId: "pi_idempotency_test",
      userId: "user-1",
    });
    // One item of 100 + 16% tax: the payment must be for exactly 116.
    await db.collection("cartItems").doc(`item-${orderId}`).set({
      cartId: "cart-idempotency-test",
      orderId,
      userId: "user-1",
      productId: "fixture-product",
      quantity: 1,
      unitPrice: 100,
      subtotal: 100,
    });

    eventId = `evt_idempotency_${orderId}`;
    const payload = JSON.stringify({
      id: eventId,
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_idempotency_test", amount_received: 116, metadata: { order_id: orderId } } },
    });
    const signature = stripeClient.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });

    const markOrderCompleteSpy = vi.spyOn(ordersDb, "markOrderComplete");
    const { app } = await createApp();

    const first = await postWebhook(app, { body: payload, signature });
    const second = await postWebhook(app, { body: payload, signature });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    // The effect (completing the order) should only have been applied
    // once, even though the same event arrived twice.
    expect(markOrderCompleteSpy).toHaveBeenCalledTimes(1);

    const updated = await docRef.get();
    expect(updated.data().status).toBe("COMPLETE");
  });
});
