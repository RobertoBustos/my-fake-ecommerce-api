import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";
import { createLoaders } from "../src/dataloaders/index.js";
import db from "../src/config/firestore.js";

// Nothing here should reach Stripe: every foreign request must be rejected
// before the payment layer. The mock makes any accidental call visible.
vi.mock("../src/db/payment.js", () => ({
  cancelPayment: vi.fn(),
  createPayment: vi.fn(),
  getCustomer: vi.fn(),
  searchPayment: vi.fn(),
  searchPaymentMethod: vi.fn(),
}));

const payment = await import("../src/db/payment.js");

const server = new ApolloServer({ typeDefs, resolvers });
const run = async (uid, query, variables) => {
  const response = await server.executeOperation(
    { query, variables },
    { contextValue: { user: { uid }, loaders: createLoaders() } }
  );
  return response.body.singleResult;
};
const errorCode = (result) => result.errors?.[0]?.extensions?.code;

const STOCK = 20;
const productId = `test-ownership-${randomUUID()}`;
const cartA = `cart-owner-a-${randomUUID()}`;
const cartB = `cart-owner-b-${randomUUID()}`;
let orderA;
let itemA;

const ADD_TO_CART = `mutation ($input: AddToCart!) {
  addToCart(input: $input) { success data { id } }
}`;
const ADDRESS = {
  address: "Calle 1",
  zipCode: "01000",
  coords: { latitude: 1, longitude: 1, latitudeDelta: 1, longitudeDelta: 1 },
};

beforeAll(async () => {
  await db.collection("products").doc(productId).set({
    title: "Ownership test product",
    price: 1,
    unitPrice: 100,
    stock: STOCK,
    purchaseLimits: { min: 1, max: STOCK },
  });
  const added = await run("user-a", ADD_TO_CART, {
    input: { cartId: cartA, productId, quantity: 2 },
  });
  expect(added.errors).toBeUndefined();
  const created = await run(
    "user-a",
    `mutation ($input: CreateOrder!) { createOrder(input: $input) { data { id } } }`,
    { input: { cartId: cartA } }
  );
  expect(created.errors).toBeUndefined();
  orderA = created.data.createOrder.data.id;

  // A second, still unordered item that user B will try to remove.
  const extra = await run("user-a", ADD_TO_CART, {
    input: { cartId: `${cartA}-extra`, productId, quantity: 1 },
  });
  itemA = extra.data.addToCart.data.id;
});

afterAll(async () => {
  await db.collection("orders").doc(orderA).delete();
  for (const cartId of [cartA, `${cartA}-extra`, cartB]) {
    const items = await db.collection("cartItems").where("cartId", "==", cartId).get();
    await Promise.all(items.docs.map((doc) => doc.ref.delete()));
  }
  await db.collection("products").doc(productId).delete();
});

describe("Mutations only touch the caller's own orders and carts", () => {
  it("user B can't add items to user A's cart", async () => {
    const result = await run("user-b", ADD_TO_CART, {
      input: { cartId: `${cartA}-extra`, productId, quantity: 1 },
    });
    expect(errorCode(result)).toBe("NOT_FOUND");
  });

  it("user B can't attach items to user A's order", async () => {
    const result = await run("user-b", ADD_TO_CART, {
      input: { cartId: cartB, productId, quantity: 1, orderId: orderA },
    });
    expect(errorCode(result)).toBe("NOT_FOUND");
  });

  it("user B can't remove user A's cart item, and the stock stays put", async () => {
    const before = (await db.collection("products").doc(productId).get()).data().stock;
    const result = await run(
      "user-b",
      `mutation ($input: RemoveFromCart!) { removeFromCart(input: $input) { success } }`,
      { input: { id: itemA } }
    );
    expect(errorCode(result)).toBe("NOT_FOUND");
    expect((await db.collection("cartItems").doc(itemA).get()).exists).toBe(true);
    expect((await db.collection("products").doc(productId).get()).data().stock).toBe(before);
  });

  it("user B can't see user A's cart", async () => {
    const result = await run(
      "user-b",
      `query ($cartId: String) { carts(cartId: $cartId) { edges { node { id } } } }`,
      { cartId: `${cartA}-extra` }
    );
    expect(result.errors).toBeUndefined();
    expect(result.data.carts.edges).toHaveLength(0);
  });

  it("user B can't turn user A's cart into an order", async () => {
    const result = await run(
      "user-b",
      `mutation ($input: CreateOrder!) { createOrder(input: $input) { success } }`,
      { input: { cartId: `${cartA}-extra` } }
    );
    expect(errorCode(result)).toBe("NOT_FOUND");
  });

  it("user B can't update user A's order", async () => {
    const result = await run(
      "user-b",
      `mutation ($input: UpdateOrder!) { updateOrder(input: $input) { success } }`,
      { input: { id: orderA, address: ADDRESS } }
    );
    expect(errorCode(result)).toBe("NOT_FOUND");
    expect((await db.collection("orders").doc(orderA).get()).data().address).toBeNull();
  });

  it("user B can't start a payment for user A's order", async () => {
    const result = await run(
      "user-b",
      `mutation ($input: CreateOrderPayment!) {
        createOrderPayment(input: $input) { success }
      }`,
      { input: { orderId: orderA } }
    );
    expect(errorCode(result)).toBe("NOT_FOUND");
    expect(payment.createPayment).not.toHaveBeenCalled();
  });

  it("user B can't cancel user A's order", async () => {
    const result = await run(
      "user-b",
      `mutation ($input: CancelOrder!) { cancelOrder(input: $input) { success } }`,
      { input: { id: orderA } }
    );
    expect(errorCode(result)).toBe("NOT_FOUND");
    expect((await db.collection("orders").doc(orderA).get()).data().status).toBe("INCOMPLETE");
  });

  it("user A can still update and cancel their own order", async () => {
    const updated = await run(
      "user-a",
      `mutation ($input: UpdateOrder!) { updateOrder(input: $input) { success } }`,
      { input: { id: orderA, address: ADDRESS } }
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data.updateOrder.success).toBe(true);

    const cancelled = await run(
      "user-a",
      `mutation ($input: CancelOrder!) { cancelOrder(input: $input) { success } }`,
      { input: { id: orderA } }
    );
    expect(cancelled.errors).toBeUndefined();
    expect(cancelled.data.cancelOrder.success).toBe(true);
  });
});
