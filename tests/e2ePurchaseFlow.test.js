import { describe, it, expect, afterAll, vi } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import db from "../src/config/firestore.js";

const WEBHOOK_SECRET = "whsec_e2e_test_secret";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

// We only mock the Stripe calls that would hit the real network (they
// don't work in CI, which runs with a placeholder key). `webhooks` keeps
// the real SDK implementation: it's local crypto, not network, and we
// need the signature on the final event to be genuinely verified.
vi.mock("../src/config/stripe.js", async () => {
  const Stripe = (await import("stripe")).default;
  const realStripe = Stripe("sk_test_fake_key_for_webhook_crypto_only");
  return {
    default: {
      customers: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ id: "cus_e2e" }),
        update: vi.fn().mockResolvedValue({ id: "cus_e2e", phone: "5555555555" }),
      },
      paymentIntents: {
        create: vi.fn().mockResolvedValue({ id: "pi_e2e", client_secret: "secret_e2e" }),
        search: vi.fn().mockResolvedValue({ data: [] }),
      },
      ephemeralKeys: {
        create: vi.fn().mockResolvedValue({ secret: "ek_e2e" }),
      },
      webhooks: realStripe.webhooks,
    },
  };
});

// Real Firebase authentication was already thoroughly tested in
// ECOMAPI-24/25; here we only care that the purchase flow chains correctly.
vi.mock("../src/auth/verifyIdToken.js", () => ({
  verifyIdToken: vi.fn().mockResolvedValue({ uid: "e2e-user" }),
}));

const stripeClient = (await import("../src/config/stripe.js")).default;
const { createApp } = await import("../src/app.js");

const postGraphQL = async (app, { query, variables }) => {
  const response = await request(app)
    .post("/graphql")
    .set("Authorization", "Bearer irrelevant-mocked-token")
    .send({ query, variables });
  return response.body;
};

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
    return response.status;
  } finally {
    server.close();
  }
};

describe("End-to-end purchase flow", () => {
  let cartId;
  let orderId;

  afterAll(async () => {
    if (orderId) {
      await db.collection("orders").doc(orderId).delete();
    }
    if (cartId) {
      const items = await db.collection("cartItems").where("cartId", "==", cartId).get();
      await Promise.all(items.docs.map((doc) => doc.ref.delete()));
    }
    await db.collection("users").doc("e2e-user").delete();
  });

  it("products -> cart -> order -> shipping details -> webhook leaves the order paid", async () => {
    cartId = `cart-e2e-${randomUUID()}`;
    const { app } = await createApp();

    // 1. Products: pick a real one from the seeded catalog.
    const productsResult = await postGraphQL(app, {
      query: `query { products(first: 1) { edges { node { id purchaseLimits { min } } } } }`,
    });
    expect(productsResult.errors).toBeUndefined();
    const product = productsResult.data.products.edges[0].node;

    // 2. Cart: add that product.
    const addToCartResult = await postGraphQL(app, {
      query: `mutation ($input: AddToCart!) {
        addToCart(input: $input) { success }
      }`,
      variables: {
        input: { cartId, productId: product.id, quantity: product.purchaseLimits.min },
      },
    });
    expect(addToCartResult.errors).toBeUndefined();
    expect(addToCartResult.data.addToCart.success).toBe(true);

    // 3. Order: convert the cart into an order.
    const createOrderResult = await postGraphQL(app, {
      query: `mutation ($input: CreateOrder!) {
        createOrder(input: $input) { success data { id status } }
      }`,
      variables: { input: { cartId } },
    });
    expect(createOrderResult.errors).toBeUndefined();
    expect(createOrderResult.data.createOrder.data.status).toBe("INCOMPLETE");
    orderId = createOrderResult.data.createOrder.data.id;

    // 4. Shipping details: once customer + address are complete, the server
    // derives PAYMENT_PENDING on its own (H3: the client doesn't send status).
    const updateOrderResult = await postGraphQL(app, {
      query: `mutation ($input: UpdateOrder!) {
        updateOrder(input: $input) { success data { status } }
      }`,
      variables: {
        input: {
          id: orderId,
          customer: { email: "e2e@example.com", name: "E2E Test", phone: "5555555555" },
          address: {
            address: "Av. Siempre Viva 742",
            zipCode: "00000",
            coords: { latitude: 0, longitude: 0, latitudeDelta: 0, longitudeDelta: 0 },
          },
        },
      },
    });
    expect(updateOrderResult.errors).toBeUndefined();
    expect(updateOrderResult.data.updateOrder.data.status).toBe("PAYMENT_PENDING");

    // 5. Payment: the PaymentIntent (mocked) is created and saved on the order.
    const createPaymentResult = await postGraphQL(app, {
      query: `mutation ($input: CreateOrderPayment!) {
        createOrderPayment(input: $input) { success data { paymentId } }
      }`,
      variables: { input: { orderId } },
    });
    expect(createPaymentResult.errors).toBeUndefined();
    expect(createPaymentResult.data.createOrderPayment.data.paymentId).toBe("pi_e2e");

    // 6. Webhook: Stripe confirms the payment with a genuinely signed event,
    // charging the amount the PaymentIntent was created with.
    const [{ amount }] = stripeClient.paymentIntents.create.mock.calls.at(-1);
    expect(amount).toBeGreaterThan(0);
    const payload = JSON.stringify({
      id: `evt_e2e_${orderId}`,
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_e2e", amount_received: amount, metadata: { order_id: orderId } } },
    });
    const signature = stripeClient.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });
    const webhookStatus = await postWebhook(app, { body: payload, signature });
    expect(webhookStatus).toBe(200);

    const finalOrder = await db.collection("orders").doc(orderId).get();
    expect(finalOrder.data().status).toBe("COMPLETE");
  }, 20000);
});
