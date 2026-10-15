import { describe, it, expect, vi, afterAll } from "vitest";
import stripeClient from "../src/config/stripe.js";
import db from "../src/config/firestore.js";
import * as ordersDb from "../src/db/orders.js";
import { createApp } from "../src/app.js";

const WEBHOOK_SECRET = "whsec_test_secret_idempotency";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

// Mismo motivo que en stripeWebhook.test.js: supertest/superagent corrompe
// un Buffer con Content-Type application/json, así que usamos fetch nativo
// contra un puerto real para preservar los bytes exactos del body firmado.
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

describe("Idempotencia de eventos de webhook", () => {
  let orderId;
  let eventId;

  afterAll(async () => {
    if (orderId) {
      await db.collection("orders").doc(orderId).delete();
    }
    if (eventId) {
      await db.collection("processedWebhookEvents").doc(eventId).delete();
    }
  });

  it("el mismo evento entregado dos veces solo aplica el efecto una vez", async () => {
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

    eventId = `evt_idempotency_${orderId}`;
    const payload = JSON.stringify({
      id: eventId,
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_idempotency_test", metadata: { order_id: orderId } } },
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

    // El efecto (completar la orden) solo debió aplicarse una vez, aunque
    // el mismo evento haya llegado dos veces.
    expect(markOrderCompleteSpy).toHaveBeenCalledTimes(1);

    const updated = await docRef.get();
    expect(updated.data().status).toBe("COMPLETE");
  });
});
