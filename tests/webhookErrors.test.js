import { describe, it, expect, vi, afterAll } from "vitest";
import stripeClient from "../src/config/stripe.js";
import db from "../src/config/firestore.js";

const WEBHOOK_SECRET = "whsec_test_secret_errors";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

// The first call fails like a Firestore outage would; later calls (Stripe's
// retry) go through to the real implementation.
const { failOnce } = vi.hoisted(() => ({ failOnce: { pending: true } }));
vi.mock("../src/db/index.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    markOrderComplete: vi.fn(async (...args) => {
      if (failOnce.pending) {
        failOnce.pending = false;
        throw new Error("Firestore unavailable");
      }
      return original.markOrderComplete(...args);
    }),
  };
});

const { createApp } = await import("../src/app.js");

// Same reason as in stripeWebhook.test.js: supertest corrupts a Buffer sent
// as application/json, so we use native fetch against a real port.
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
    return {
      status: response.status,
      requestId: response.headers.get("x-request-id"),
      body: await response.json().catch(() => null),
    };
  } finally {
    server.close();
  }
};

describe("Stripe webhook when processing fails (ECOMAPI-48)", () => {
  let orderId;
  const eventId = "evt_test_processing_fails";

  afterAll(async () => {
    vi.restoreAllMocks();
    if (orderId) {
      await db.collection("orders").doc(orderId).delete();
      await db.collection("cartItems").doc(`item-${orderId}`).delete();
    }
    await db.collection("processedWebhookEvents").doc(eventId).delete();
  });

  it("answers 500, logs the error and lets Stripe's retry complete the order", async () => {
    const docRef = db.collection("orders").doc();
    orderId = docRef.id;
    await docRef.set({
      cart: "cart-webhook-errors-test",
      status: "PAYMENT_PENDING",
      customer: null,
      address: null,
      paymentId: "pi_test_errors",
      userId: "user-1",
    });
    // One item of 100 + 16% tax: the payment must be for exactly 116.
    await db.collection("cartItems").doc(`item-${orderId}`).set({
      cartId: "cart-webhook-errors-test",
      orderId,
      userId: "user-1",
      productId: "fixture-product",
      quantity: 1,
      unitPrice: 100,
      subtotal: 100,
    });

    const payload = JSON.stringify({
      id: eventId,
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_test_errors", amount_received: 116, metadata: { order_id: orderId } } },
    });
    const sign = () =>
      stripeClient.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    const logs = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      logs.push(...String(chunk).split("\n").filter(Boolean).map((line) => JSON.parse(line)));
      return true;
    });

    const { app, httpServer } = await createApp();
    try {
      // First delivery: processing fails. Before the fix the promise rejection
      // went unhandled; now it's a 500 that Stripe will retry.
      const first = await postWebhook(app, { body: payload, signature: sign() });
      expect(first.status).toBe(500);
      expect(logs).toContainEqual(
        expect.objectContaining({
          severity: "ERROR",
          message: "Firestore unavailable",
          requestId: first.requestId,
        })
      );

      // Stripe's retry: must be processed again, not skipped as a duplicate.
      const retry = await postWebhook(app, { body: payload, signature: sign() });
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual({ received: true });
    } finally {
      httpServer.close();
    }

    const order = await db.collection("orders").doc(orderId).get();
    expect(order.data().status).toBe("COMPLETE");
  });
});
