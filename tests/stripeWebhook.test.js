import { describe, it, expect, afterAll, vi } from "vitest";
import stripeClient from "../src/config/stripe.js";
import db from "../src/config/firestore.js";
import { createApp } from "../src/app.js";

const WEBHOOK_SECRET = "whsec_test_secret";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

// supertest/superagent re-serialize a Buffer as JSON {type:"Buffer",data:[...]}
// instead of sending it raw when the declared Content-Type is
// application/json, which breaks signature verification. For this endpoint
// (which needs the exact raw bytes of the body) we use native fetch
// against a real port.
const postWebhook = async (app, { body, signature }) => {
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/stripe`, {
      method: "POST",
      headers: {
        "stripe-signature": signature,
        "Content-Type": "application/json",
      },
      body,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } finally {
    server.close();
  }
};

describe("Stripe webhook with signature (H11)", () => {
  let orderId;

  afterAll(async () => {
    if (orderId) {
      await db.collection("orders").doc(orderId).delete();
      await db.collection("cartItems").doc(`item-${orderId}`).delete();
    }
  });

  it("a validly signed event leaves the order in COMPLETE", async () => {
    const docRef = db.collection("orders").doc();
    orderId = docRef.id;
    await docRef.set({
      cart: "cart-webhook-test",
      status: "PAYMENT_PENDING",
      customer: null,
      address: null,
      paymentId: "pi_test",
      userId: "user-1",
    });
    // One item of 100 + 16% tax: the payment must be for exactly 116.
    await db.collection("cartItems").doc(`item-${orderId}`).set({
      cartId: "cart-webhook-test",
      orderId,
      userId: "user-1",
      productId: "fixture-product",
      quantity: 1,
      unitPrice: 100,
      subtotal: 100,
    });

    const payload = JSON.stringify({
      id: "evt_test",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_test", amount_received: 116, metadata: { order_id: orderId } } },
    });
    const signature = stripeClient.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });

    const { app } = await createApp();
    const response = await postWebhook(app, { body: payload, signature });

    expect(response.status).toBe(200);

    const updated = await docRef.get();
    expect(updated.data().status).toBe("COMPLETE");
  });

  it("an invalid signature returns 400", async () => {
    const payload = JSON.stringify({
      id: "evt_test_2",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_test_2", metadata: {} } },
    });

    const { app } = await createApp();
    const response = await postWebhook(app, {
      body: payload,
      signature: "t=1699999999,v1=not-a-real-signature",
    });

    expect(response.status).toBe(400);
  });

  it("a payment for a cancelled order is answered 200 and logged, not applied", async () => {
    const docRef = db.collection("orders").doc();
    const eventId = `evt_cancelled_${docRef.id}`;
    await docRef.set({
      cart: "cart-webhook-cancelled-test",
      status: "CANCELLED",
      customer: null,
      address: null,
      paymentId: "pi_cancelled",
      userId: "user-1",
    });
    const payload = JSON.stringify({
      id: eventId,
      type: "payment_intent.succeeded",
      data: {
        object: { id: "pi_cancelled", amount_received: 116, metadata: { order_id: docRef.id } },
      },
    });
    const signature = stripeClient.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });
    const logs = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      logs.push(...String(chunk).split("\n").filter(Boolean).map((line) => JSON.parse(line)));
      return true;
    });

    try {
      const { app } = await createApp();
      const response = await postWebhook(app, { body: payload, signature });

      // A retry wouldn't change anything, so Stripe must not keep retrying.
      expect(response.status).toBe(200);
      expect(logs).toContainEqual(
        expect.objectContaining({
          severity: "ERROR",
          message: "Payment not applied to its order",
          orderId: docRef.id,
          reason: "order is CANCELLED",
        })
      );
      expect((await docRef.get()).data().status).toBe("CANCELLED");
    } finally {
      stderr.mockRestore();
      await docRef.delete();
      await db.collection("processedWebhookEvents").doc(eventId).delete();
    }
  });
});
