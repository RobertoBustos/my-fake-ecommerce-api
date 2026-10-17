import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";
import { createLoaders } from "../src/dataloaders/index.js";
import db from "../src/config/firestore.js";
import { markOrderComplete } from "../src/db/orders.js";

const { payment } = vi.hoisted(() => ({
  payment: {
    cancelPayment: vi.fn().mockResolvedValue(true),
    createPayment: vi.fn().mockResolvedValue({
      paymentId: "pi_transitions",
      clientSecret: "secret",
      ephimeralKey: "ek",
    }),
    getCustomer: vi.fn().mockResolvedValue({ id: "cus_transitions" }),
    searchPayment: vi.fn().mockResolvedValue(null),
    searchPaymentMethod: vi.fn(),
  },
}));
vi.mock("../src/db/payment.js", () => payment);

const USER = "user-transitions";
const server = new ApolloServer({ typeDefs, resolvers });
const run = async (query, variables) => {
  const response = await server.executeOperation(
    { query, variables },
    { contextValue: { user: { uid: USER }, loaders: createLoaders() } }
  );
  return response.body.singleResult;
};
const errorOf = (result) => result.errors?.[0]?.extensions;

const ADD_TO_CART = `mutation ($input: AddToCart!) {
  addToCart(input: $input) { success data { id } }
}`;
const CREATE_ORDER = `mutation ($input: CreateOrder!) {
  createOrder(input: $input) { success data { id } }
}`;
const UPDATE_ORDER = `mutation ($input: UpdateOrder!) {
  updateOrder(input: $input) { success data { status } }
}`;
const CREATE_PAYMENT = `mutation ($input: CreateOrderPayment!) {
  createOrderPayment(input: $input) { success }
}`;
const CANCEL_ORDER = `mutation ($input: CancelOrder!) {
  cancelOrder(input: $input) { success }
}`;
const REMOVE_FROM_CART = `mutation ($input: RemoveFromCart!) {
  removeFromCart(input: $input) { success }
}`;
const DETAILS = {
  customer: { email: "t@example.com", name: "Transitions", phone: "5555555555" },
  address: {
    address: "Calle 1",
    zipCode: "01000",
    coords: { latitude: 1, longitude: 1, latitudeDelta: 1, longitudeDelta: 1 },
  },
};

const STOCK = 50;
const productId = `test-transitions-${randomUUID()}`;
const carts = [];
const orders = [];

const stock = async () => (await db.collection("products").doc(productId).get()).data().stock;
const statusOf = async (orderId) =>
  (await db.collection("orders").doc(orderId).get()).data().status;

// A cart with one unit of the test product (100 + 16% tax), ordered.
const placeOrder = async ({ withDetails = true } = {}) => {
  const cartId = `cart-transitions-${randomUUID()}`;
  carts.push(cartId);
  const added = await run(ADD_TO_CART, { input: { cartId, productId, quantity: 1 } });
  expect(added.errors).toBeUndefined();
  const created = await run(CREATE_ORDER, { input: { cartId } });
  expect(created.errors).toBeUndefined();
  const orderId = created.data.createOrder.data.id;
  orders.push(orderId);
  if (withDetails) {
    const updated = await run(UPDATE_ORDER, { input: { id: orderId, ...DETAILS } });
    expect(updated.errors).toBeUndefined();
  }
  return { cartId, orderId, itemId: added.data.addToCart.data.id };
};
const setStatus = (orderId, status, extra = {}) =>
  db.collection("orders").doc(orderId).update({ status, ...extra });

beforeEach(async () => {
  vi.clearAllMocks();
  await db.collection("products").doc(productId).set({
    title: "Transitions test product",
    price: 1,
    unitPrice: 100,
    stock: STOCK,
    purchaseLimits: { min: 1, max: STOCK },
  });
});

afterAll(async () => {
  await Promise.all(orders.map((id) => db.collection("orders").doc(id).delete()));
  for (const cartId of carts) {
    const items = await db.collection("cartItems").where("cartId", "==", cartId).get();
    await Promise.all(items.docs.map((doc) => doc.ref.delete()));
  }
  await db.collection("products").doc(productId).delete();
});

describe("order status transitions", () => {
  it.each(["COMPLETE", "CANCELLED"])("updateOrder doesn't reopen a %s order", async (status) => {
    const { orderId } = await placeOrder();
    await setStatus(orderId, status);

    const result = await run(UPDATE_ORDER, { input: { id: orderId, ...DETAILS } });

    expect(errorOf(result)).toMatchObject({ code: "BAD_USER_INPUT", invalidArgument: "id" });
    expect(await statusOf(orderId)).toBe(status);
  });

  it.each(["INCOMPLETE", "COMPLETE", "CANCELLED"])(
    "createOrderPayment refuses a %s order",
    async (status) => {
      const { orderId } = await placeOrder();
      await setStatus(orderId, status);

      const result = await run(CREATE_PAYMENT, { input: { orderId } });

      expect(errorOf(result)).toMatchObject({ code: "BAD_USER_INPUT", invalidArgument: "orderId" });
      expect(payment.createPayment).not.toHaveBeenCalled();
    }
  );

  it("createOrderPayment charges an order that is PAYMENT_PENDING", async () => {
    const { orderId } = await placeOrder();

    const result = await run(CREATE_PAYMENT, { input: { orderId } });

    expect(result.errors).toBeUndefined();
    expect(payment.createPayment).toHaveBeenCalledWith(orderId, 116, "cus_transitions");
  });

  it("createOrder rejects a cart that was already ordered", async () => {
    const { cartId } = await placeOrder();

    const result = await run(CREATE_ORDER, { input: { cartId } });

    expect(errorOf(result)).toMatchObject({ code: "BAD_USER_INPUT", invalidArgument: "cartId" });
  });

  it("two concurrent createOrder calls for one cart create a single order", async () => {
    const cartId = `cart-transitions-${randomUUID()}`;
    carts.push(cartId);
    await run(ADD_TO_CART, { input: { cartId, productId, quantity: 1 } });

    const results = await Promise.all([
      run(CREATE_ORDER, { input: { cartId } }),
      run(CREATE_ORDER, { input: { cartId } }),
    ]);
    results
      .filter((result) => !result.errors)
      .forEach((result) => orders.push(result.data.createOrder.data.id));

    expect(results.filter((result) => !result.errors)).toHaveLength(1);
    expect(errorOf(results.find((result) => result.errors))).toMatchObject({
      code: "BAD_USER_INPUT",
      invalidArgument: "cartId",
    });
  });

  it("addToCart with an open order puts the item in the order total", async () => {
    const { cartId, orderId } = await placeOrder();

    const added = await run(ADD_TO_CART, { input: { cartId, orderId, productId, quantity: 2 } });

    expect(added.errors).toBeUndefined();
    const item = await db.collection("cartItems").doc(added.data.addToCart.data.id).get();
    expect(item.data().orderId).toBe(orderId);
    await run(CREATE_PAYMENT, { input: { orderId } });
    // 3 units of 100, plus 16% tax.
    expect(payment.createPayment).toHaveBeenCalledWith(orderId, 348, "cus_transitions");
  });

  it.each(["COMPLETE", "CANCELLED"])("addToCart refuses a %s order", async (status) => {
    const { cartId, orderId } = await placeOrder();
    await setStatus(orderId, status);
    const before = await stock();

    const result = await run(ADD_TO_CART, { input: { cartId, orderId, productId, quantity: 1 } });

    expect(errorOf(result)).toMatchObject({ code: "BAD_USER_INPUT", invalidArgument: "orderId" });
    expect(await stock()).toBe(before);
  });

  it("addToCart refuses an orderId with another cartId", async () => {
    const { orderId } = await placeOrder();

    const result = await run(ADD_TO_CART, {
      input: { cartId: `cart-other-${randomUUID()}`, orderId, productId, quantity: 1 },
    });

    expect(errorOf(result)).toMatchObject({ code: "BAD_USER_INPUT", invalidArgument: "cartId" });
  });

  it.each(["COMPLETE", "CANCELLED"])(
    "removeFromCart keeps the items of a %s order",
    async (status) => {
      const { orderId, itemId } = await placeOrder();
      await setStatus(orderId, status);
      const before = await stock();

      const result = await run(REMOVE_FROM_CART, { input: { id: itemId } });

      expect(errorOf(result)).toMatchObject({ code: "BAD_USER_INPUT", invalidArgument: "id" });
      expect((await db.collection("cartItems").doc(itemId).get()).exists).toBe(true);
      expect(await stock()).toBe(before);
    }
  );

  it("cancelOrder refuses an order whose payment already went through", async () => {
    const { orderId } = await placeOrder();
    await setStatus(orderId, "PAYMENT_PENDING", { paymentId: "pi_paid" });
    payment.searchPayment.mockResolvedValueOnce({ id: "pi_paid", status: "succeeded" });
    const before = await stock();

    const result = await run(CANCEL_ORDER, { input: { id: orderId } });

    expect(errorOf(result)).toMatchObject({ code: "BAD_USER_INPUT" });
    expect(await statusOf(orderId)).toBe("PAYMENT_PENDING");
    expect(await stock()).toBe(before);
  });
});

describe("webhook checks before completing an order", () => {
  const paidOrder = async () => {
    const { orderId } = await placeOrder();
    await setStatus(orderId, "PAYMENT_PENDING", { paymentId: "pi_order" });
    return orderId;
  };

  it("completes the order when the PaymentIntent and the amount match", async () => {
    const orderId = await paidOrder();

    const result = await markOrderComplete(orderId, {
      paymentIntentId: "pi_order",
      amountReceived: 116,
    });

    expect(result.completed).toBe(true);
    expect(await statusOf(orderId)).toBe("COMPLETE");
  });

  it("doesn't complete a cancelled order", async () => {
    const orderId = await paidOrder();
    await setStatus(orderId, "CANCELLED");

    const result = await markOrderComplete(orderId, {
      paymentIntentId: "pi_order",
      amountReceived: 116,
    });

    expect(result).toEqual({ completed: false, reason: "order is CANCELLED" });
    expect(await statusOf(orderId)).toBe("CANCELLED");
  });

  it("doesn't complete an order paid through another PaymentIntent", async () => {
    const orderId = await paidOrder();

    const result = await markOrderComplete(orderId, {
      paymentIntentId: "pi_someone_else",
      amountReceived: 116,
    });

    expect(result.completed).toBe(false);
    expect(await statusOf(orderId)).toBe("PAYMENT_PENDING");
  });

  it("doesn't complete an order that grew after the PaymentIntent was created", async () => {
    const orderId = await paidOrder();
    const order = (await db.collection("orders").doc(orderId).get()).data();
    await run(ADD_TO_CART, { input: { cartId: order.cart, orderId, productId, quantity: 1 } });

    // Stripe charged the old total; the order is now 232.
    const result = await markOrderComplete(orderId, {
      paymentIntentId: "pi_order",
      amountReceived: 116,
    });

    expect(result.completed).toBe(false);
    expect(result.reason).toMatch(/amount received \(116\).*total \(232\)/);
    expect(await statusOf(orderId)).toBe("PAYMENT_PENDING");
  });
});
