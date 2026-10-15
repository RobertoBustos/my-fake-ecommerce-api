import { describe, it, expect, afterAll } from "vitest";
import stripeClient from "../src/config/stripe.js";
import db from "../src/config/firestore.js";
import { createApp } from "../src/app.js";

const WEBHOOK_SECRET = "whsec_test_secret";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

// supertest/superagent re-serializan un Buffer como JSON {type:"Buffer",data:[...]}
// en vez de mandarlo crudo cuando el Content-Type declarado es application/json,
// lo cual rompe la verificación de firma. Para este endpoint (que necesita los
// bytes exactos del body) usamos fetch nativo contra un puerto real.
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

describe("Webhook de Stripe con firma (H11)", () => {
  let orderId;

  afterAll(async () => {
    if (orderId) {
      await db.collection("orders").doc(orderId).delete();
    }
  });

  it("un evento firmado válido deja la orden en COMPLETE", async () => {
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

    const payload = JSON.stringify({
      id: "evt_test",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_test", metadata: { order_id: orderId } } },
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

  it("una firma inválida regresa 400", async () => {
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
});
