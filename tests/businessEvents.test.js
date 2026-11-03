import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import db from "../src/config/firestore.js";
import { readFileSync } from "fs";
import { EVENTS, eventFields, SCHEMA_VERSION, UndeclaredEventFieldError } from "../src/observability/events.js";

const WEBHOOK_SECRET = "whsec_events_test_secret";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

// Only the Stripe calls that would hit the network are mocked; the webhook
// signature is genuinely verified (as in e2ePurchaseFlow.test.js).
vi.mock("../src/config/stripe.js", async () => {
  const Stripe = (await import("stripe")).default;
  const realStripe = new Stripe("sk_test_fake_key_for_webhook_crypto_only");
  return {
    default: {
      customers: {
        create: vi.fn().mockResolvedValue({ id: "cus_events" }),
        update: vi.fn().mockResolvedValue({ id: "cus_events" }),
      },
      paymentIntents: {
        create: vi.fn().mockResolvedValue({ id: "pi_events", client_secret: "secret_events" }),
        search: vi.fn().mockResolvedValue({ data: [] }),
      },
      ephemeralKeys: { create: vi.fn().mockResolvedValue({ secret: "ek_events" }) },
      webhooks: realStripe.webhooks,
    },
  };
});

const USER = "events-user";
vi.mock("../src/auth/verifyIdToken.js", () => ({
  verifyIdToken: vi.fn().mockResolvedValue({ uid: "events-user" }),
}));

const stripeClient = (await import("../src/config/stripe.js")).default;
const { createApp } = await import("../src/app.js");

// Every business event the logger writes from now on, parsed back.
const captureEvents = () => {
  const lines = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(...String(chunk).split("\n").filter((line) => line.startsWith("{")));
    return true;
  });
  return () => lines.map((line) => JSON.parse(line)).filter((entry) => entry.event);
};

const graphql = async (app, query, variables) =>
  (await request(app).post("/graphql").set("Authorization", "Bearer mocked").send({ query, variables })).body;

const deliver = async (app, object, type = "payment_intent.succeeded") => {
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

const PERSONAL = /email|name|phone|address|card|street|zip/i;

describe("business events: catalog", () => {
  it("declares no field that could carry personal data", () => {
    for (const [event, fields] of Object.entries(EVENTS)) {
      for (const field of fields) expect(field, `${event}.${field}`).not.toMatch(PERSONAL);
    }
  });

  it("rejects a field the event doesn't declare", () => {
    expect(() => eventFields("order.created", { email: "someone@example.com" })).toThrow(UndeclaredEventFieldError);
  });

  it("stamps the schema version, and e2e for the e2e suite's carts", () => {
    expect(eventFields("order.cancelled", { orderId: "o1", cartId: "e2e-123" })).toEqual({
      event: "order.cancelled",
      schemaVersion: SCHEMA_VERSION,
      e2e: true,
      orderId: "o1",
      cartId: "e2e-123",
    });
    expect(eventFields("order.cancelled", { orderId: "o1", cartId: "cart-1" }).e2e).toBe(false);
  });

  it("writes what the BigQuery sink and the log-based metrics select on", () => {
    const sink = JSON.parse(readFileSync(new URL("../ops/analytics/events-sink.json", import.meta.url), "utf8"));
    const metric = JSON.parse(
      readFileSync(new URL("../ops/monitoring/metrics/business-events.json", import.meta.url), "utf8")
    );
    for (const filter of [sink.filter, metric.filter]) {
      expect(filter).toContain("jsonPayload.schemaVersion>=1");
      expect(filter).toContain("jsonPayload.event:*");
    }
    const line = eventFields("customer.created", {});
    expect(line.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(typeof line.event).toBe("string");
  });
});

describe("business events: the purchase funnel", () => {
  const cartIds = [];
  const orderIds = [];

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    for (const orderId of orderIds) await db.collection("orders").doc(orderId).delete();
    for (const cartId of cartIds) {
      const items = await db.collection("cartItems").where("cartId", "==", cartId).get();
      await Promise.all(items.docs.map((doc) => doc.ref.delete()));
    }
    await db.collection("users").doc(USER).delete();
  });

  // Cart with one product, ordered and ready to pay; returns its ids and the
  // amount the PaymentIntent was created with.
  const orderReadyToPay = async (app) => {
    const cartId = `e2e-${randomUUID()}`;
    cartIds.push(cartId);
    const products = await graphql(app, "{ products(first: 1) { edges { node { id purchaseLimits { min } } } } }");
    const product = products.data.products.edges[0].node;
    await graphql(app, "mutation ($input: AddToCart!) { addToCart(input: $input) { success } }", {
      input: { cartId, productId: product.id, quantity: product.purchaseLimits.min },
    });
    const created = await graphql(app, "mutation ($input: CreateOrder!) { createOrder(input: $input) { data { id } } }", {
      input: { cartId },
    });
    const orderId = created.data.createOrder.data.id;
    orderIds.push(orderId);
    await graphql(app, "mutation ($input: UpdateOrder!) { updateOrder(input: $input) { success } }", {
      input: {
        id: orderId,
        customer: { email: "events@example.com", name: "Events Test", phone: "5555555555" },
        address: {
          address: "Av. Siempre Viva 742",
          zipCode: "00000",
          coords: { latitude: 0, longitude: 0, latitudeDelta: 0, longitudeDelta: 0 },
        },
      },
    });
    const paid = await graphql(
      app,
      "mutation ($input: CreateOrderPayment!) { createOrderPayment(input: $input) { success } }",
      { input: { orderId } }
    );
    expect(paid.errors).toBeUndefined();
    const [{ amount }] = stripeClient.paymentIntents.create.mock.calls.at(-1);
    return { cartId, orderId, amount };
  };

  it("emits each step once, marked e2e, with no personal data", async () => {
    const { app } = await createApp();
    const events = captureEvents();
    const { cartId, orderId, amount } = await orderReadyToPay(app);
    expect(await deliver(app, { id: "pi_events", amount_received: amount, currency: "mxn", metadata: { order_id: orderId } })).toBe(200);

    const emitted = events();
    expect(emitted.map((entry) => entry.event)).toEqual([
      "cart.item_added",
      "order.created",
      // The order's first details create the user's Stripe customer.
      "customer.created",
      "order.ready_to_pay",
      "payment.intent_created",
      // The webhook confirms the order's reservation right after its commit,
      // before it records the purchase.
      "inventory.task_done",
      "order.completed",
    ]);
    const completed = emitted.find((entry) => entry.event === "order.completed");
    expect(completed).toMatchObject({ orderId, cartId, amount, currency: "MXN", e2e: true, schemaVersion: SCHEMA_VERSION });
    expect(emitted.find((entry) => entry.event === "order.created")).toMatchObject({ orderId, cartId, total: amount });
    const text = JSON.stringify(emitted);
    for (const personal of ["events@example.com", "Events Test", "5555555555", "Siempre Viva"]) {
      expect(text).not.toContain(personal);
    }
  }, 30000);

  it("records one purchase when two deliveries race and a transaction retries", async () => {
    const { app } = await createApp();
    const { orderId, amount } = await orderReadyToPay(app);
    const events = captureEvents();

    // Two distinct events for the same payment, at once: both transactions
    // read the order, one commits and the other retries and finds it complete.
    const object = { id: "pi_events", amount_received: amount, currency: "mxn", metadata: { order_id: orderId } };
    const statuses = await Promise.all([deliver(app, object), deliver(app, object)]);

    expect(statuses).toEqual([200, 200]);
    expect(events().filter((entry) => entry.event === "order.completed")).toHaveLength(1);
  }, 30000);

  it("records a failed payment with Stripe's code and nothing about the card", async () => {
    const { app } = await createApp();
    const { cartId, orderId, amount } = await orderReadyToPay(app);
    const events = captureEvents();

    const status = await deliver(
      app,
      {
        id: "pi_events",
        amount,
        currency: "mxn",
        metadata: { order_id: orderId },
        last_payment_error: { code: "card_declined", decline_code: "insufficient_funds", payment_method: { card: { last4: "4242" } } },
      },
      "payment_intent.payment_failed"
    );

    expect(status).toBe(200);
    const failed = events().filter((entry) => entry.event === "payment.failed");
    expect(failed).toEqual([
      expect.objectContaining({ orderId, cartId, amount, currency: "MXN", failureCode: "insufficient_funds", e2e: true }),
    ]);
    expect(JSON.stringify(failed)).not.toContain("4242");
    // The order is untouched: the client can pay again.
    expect((await db.collection("orders").doc(orderId).get()).data().status).toBe("PAYMENT_PENDING");
  }, 30000);
});
