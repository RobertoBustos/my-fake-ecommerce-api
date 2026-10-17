import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";
import { createLoaders } from "../src/dataloaders/index.js";
import db from "../src/config/firestore.js";

// A fake Stripe that keeps customers in memory, so the test can see which
// customer each order and each ephemeral key ended up with.
const { stripeMock } = vi.hoisted(() => {
  const customers = new Map();
  let next = 0;
  return {
    stripeMock: {
      customers: {
        search: vi.fn(),
        create: vi.fn(async ({ metadata }) => {
          const customer = { id: `cus_${++next}`, metadata };
          customers.set(customer.id, customer);
          return customer;
        }),
        update: vi.fn(async (id, details) => {
          const customer = { ...customers.get(id), ...details };
          customers.set(id, customer);
          return customer;
        }),
      },
      paymentIntents: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn(async (params) => ({ id: `pi_${randomUUID()}`, client_secret: "secret", ...params })),
      },
      ephemeralKeys: {
        create: vi.fn().mockResolvedValue({ secret: "ek_test" }),
      },
    },
  };
});

vi.mock("../src/config/stripe.js", () => ({ default: stripeMock }));

const server = new ApolloServer({ typeDefs, resolvers });
const run = async (uid, query, variables) => {
  const response = await server.executeOperation(
    { query, variables },
    { contextValue: { user: { uid }, loaders: createLoaders() } }
  );
  return response.body.singleResult;
};

const userA = `stripe-user-a-${randomUUID()}`;
const userB = `stripe-user-b-${randomUUID()}`;
const productId = `test-stripe-customer-${randomUUID()}`;
const carts = [];
const orders = [];
const SHARED_EMAIL = "victim@example.com";
const ADDRESS = {
  address: "Calle 1",
  zipCode: "01000",
  coords: { latitude: 1, longitude: 1, latitudeDelta: 1, longitudeDelta: 1 },
};

// Cart → order → shipping details, as the app does before paying.
const placeOrder = async (uid, email) => {
  const cartId = `cart-stripe-${randomUUID()}`;
  carts.push(cartId);
  const added = await run(
    uid,
    `mutation ($input: AddToCart!) { addToCart(input: $input) { success } }`,
    { input: { cartId, productId, quantity: 1 } }
  );
  expect(added.errors).toBeUndefined();
  const created = await run(
    uid,
    `mutation ($input: CreateOrder!) { createOrder(input: $input) { data { id } } }`,
    { input: { cartId } }
  );
  const orderId = created.data.createOrder.data.id;
  orders.push(orderId);
  const updated = await run(
    uid,
    `mutation ($input: UpdateOrder!) { updateOrder(input: $input) { success } }`,
    { input: { id: orderId, customer: { email, name: "Someone", phone: "5555555555" }, address: ADDRESS } }
  );
  expect(updated.errors).toBeUndefined();
  const order = await db.collection("orders").doc(orderId).get();
  return { orderId, customerId: order.data().customer.id };
};

beforeAll(async () => {
  await db.collection("products").doc(productId).set({
    title: "Stripe customer test product",
    price: 1,
    unitPrice: 100,
    stock: 10,
    purchaseLimits: { min: 1, max: 10 },
  });
});

afterAll(async () => {
  await Promise.all(orders.map((id) => db.collection("orders").doc(id).delete()));
  for (const cartId of carts) {
    const items = await db.collection("cartItems").where("cartId", "==", cartId).get();
    await Promise.all(items.docs.map((doc) => doc.ref.delete()));
  }
  await Promise.all([userA, userB].map((uid) => db.collection("users").doc(uid).delete()));
  await db.collection("products").doc(productId).delete();
});

describe("Stripe customer per Firebase user", () => {
  it("gives a user who types someone else's email their own customer and ephemeral key", async () => {
    const a = await placeOrder(userA, SHARED_EMAIL);
    const b = await placeOrder(userB, SHARED_EMAIL);

    expect(b.customerId).not.toBe(a.customerId);
    expect(stripeMock.customers.search).not.toHaveBeenCalled();
    expect(stripeMock.customers.create).toHaveBeenCalledWith(
      { metadata: { firebase_uid: userB } },
      { idempotencyKey: `customer-${userB}` }
    );

    stripeMock.ephemeralKeys.create.mockClear();
    const paid = await run(
      userB,
      `mutation ($input: CreateOrderPayment!) { createOrderPayment(input: $input) { success } }`,
      { input: { orderId: b.orderId } }
    );
    expect(paid.errors).toBeUndefined();
    expect(stripeMock.ephemeralKeys.create).toHaveBeenCalledWith(
      { customer: b.customerId },
      expect.anything()
    );
  });

  it("reuses the same customer for every order of the same user", async () => {
    const first = await placeOrder(userA, "a@example.com");
    const second = await placeOrder(userA, "a.new@example.com");

    expect(second.customerId).toBe(first.customerId);
    const user = await db.collection("users").doc(userA).get();
    expect(user.data().stripeCustomerId).toBe(first.customerId);
  });
});
