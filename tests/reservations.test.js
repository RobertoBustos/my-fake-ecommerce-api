import { describe, it, expect, vi, afterAll, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";
import { createLoaders } from "../src/dataloaders/index.js";
import db from "../src/config/firestore.js";
import {
  OutOfStockError,
  ReservationExpiredError,
  toGlobalProductId,
  withCoreReservations,
} from "../src/catalog/index.js";
import { firestoreCatalogSource as fs } from "../src/catalog/sources/firestore/adapter.js";
import { TransactionContentionError } from "../src/db/transactions.js";

const { payment } = vi.hoisted(() => ({
  payment: {
    cancelPayment: vi.fn().mockResolvedValue(true),
    createPayment: vi.fn().mockResolvedValue({
      paymentId: "pi_reservations",
      clientSecret: "secret",
      ephimeralKey: "ek",
    }),
    getCustomer: vi.fn().mockResolvedValue({ id: "cus_reservations" }),
    searchPayment: vi.fn().mockResolvedValue(null),
    searchPaymentMethod: vi.fn(),
  },
}));
vi.mock("../src/db/payment.js", () => payment);

const productIds = [];
const newProduct = async (stock) => {
  const id = `test-reservation-${randomUUID()}`;
  productIds.push(id);
  await db.collection("products").doc(id).set({
    title: "Reservation fixture",
    description: "",
    category: "test-reservations",
    image: "",
    currency: "MXN",
    unitPrice: 100,
    purchaseLimits: { min: 1, max: 20 },
    stock,
  });
  return id;
};
const stockOf = async (id) => (await db.collection("products").doc(id).get()).get("stock");
const reservationDoc = async (id) => (await db.collection("reservations").doc(id).get()).data();
const key = () => `test-key-${randomUUID()}`;

afterAll(async () => {
  await Promise.all(productIds.map((id) => db.collection("products").doc(id).delete()));
});

describe("Firestore reservations (ECOMAPI-74)", () => {
  afterEach(() => {
    delete process.env.RESERVATION_TTL_MINUTES_FS;
  });

  it("two reserves with the same key take the units once", async () => {
    const id = await newProduct(10);
    const k = key();

    const [first, second] = await Promise.all([fs.reserve(id, 3, k), fs.reserve(id, 3, k)]);
    const third = await fs.reserve(id, 3, k);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(await stockOf(id)).toBe(7);
    expect(await reservationDoc(k)).toMatchObject({ status: "HELD", quantity: 3, localId: id, sourceKey: "fs" });
  });

  it("expires after the source's configured minutes", async () => {
    process.env.RESERVATION_TTL_MINUTES_FS = "5";
    const id = await newProduct(1);
    const before = Date.now();

    const { expiresAt } = await fs.reserve(id, 1, key());

    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(5 * 60_000 + 1000);
  });

  it("a release puts the units back once, however many times it is called", async () => {
    const id = await newProduct(5);
    const reservation = await fs.reserve(id, 2, key());

    await Promise.all([fs.release(reservation, "a"), fs.release(reservation, "b")]);
    await fs.release(reservation, "c");

    expect(await stockOf(id)).toBe(5);
    expect((await reservationDoc(reservation.reservationId)).status).toBe("RELEASED");
  });

  it("a confirmed reservation is sold: a release doesn't put it back", async () => {
    const id = await newProduct(5);
    const reservation = await fs.reserve(id, 2, key());

    await fs.confirm(reservation, "confirm");
    await fs.confirm(reservation, "confirm-again");
    await fs.release(reservation, "release");

    expect(await stockOf(id)).toBe(3);
    expect((await reservationDoc(reservation.reservationId)).status).toBe("CONFIRMED");
  });

  it("a released reservation can't be confirmed", async () => {
    const id = await newProduct(5);
    const reservation = await fs.reserve(id, 2, key());
    await fs.release(reservation, "release");

    await expect(fs.confirm(reservation, "confirm")).rejects.toBeInstanceOf(ReservationExpiredError);
  });

  it("releases units reserved before reservations existed once, from what it is given", async () => {
    const id = await newProduct(4);
    const legacy = { reservationId: `cartItem-${randomUUID()}`, localId: id, quantity: 2, expiresAt: null };

    await fs.release(legacy, "first");
    await fs.release(legacy, "second");

    expect(await stockOf(id)).toBe(6);
  });

  it("20 concurrent reserves of one product never oversell", async () => {
    const id = await newProduct(10);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => fs.reserve(id, 1, key()))
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;

    expect(succeeded).toBeGreaterThan(0);
    expect(succeeded).toBeLessThanOrEqual(10);
    expect(await stockOf(id)).toBe(10 - succeeded);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect([OutOfStockError, TransactionContentionError]).toContain(r.reason.constructor);
    }
  }, 60000);
});

describe("reservations kept for a source that can't reserve (ECOMAPI-74)", () => {
  let available = 5;
  const readOnlySource = {
    key: "readonly",
    displayName: "Read-only vendor",
    capabilities: { reservations: false, changeFeed: false },
    listChanged: async () => ({ items: [], deletedIds: [] }),
    getProducts: vi.fn(async (ids) => ids.map((localId) => ({ localId, available }))),
    reserve: vi.fn(),
    confirm: vi.fn(),
    release: vi.fn(),
  };
  const source = withCoreReservations(readOnlySource);

  it("keeps the reservation in Firestore without touching the source", async () => {
    const k = key();
    const reservation = await source.reserve("sku-1", 2, k);
    await source.reserve("sku-1", 2, k);

    expect(reservation).toMatchObject({ reservationId: k, localId: "sku-1", quantity: 2 });
    expect(await reservationDoc(k)).toMatchObject({ status: "HELD", sourceKey: "readonly" });
    expect(readOnlySource.reserve).not.toHaveBeenCalled();
  });

  it("refuses more units than the source has now", async () => {
    await expect(source.reserve("sku-1", 6, key())).rejects.toBeInstanceOf(OutOfStockError);
  });

  it("checks available again when confirming", async () => {
    available = 5;
    const reservation = await source.reserve("sku-1", 3, key());
    available = 2;

    await expect(source.confirm(reservation, "confirm")).rejects.toBeInstanceOf(OutOfStockError);
    available = 3;
    await source.confirm(reservation, "confirm");
    expect((await reservationDoc(reservation.reservationId)).status).toBe("CONFIRMED");
  });

  it("releases once", async () => {
    available = 5;
    const reservation = await source.reserve("sku-1", 1, key());
    await source.release(reservation, "a");
    await source.release(reservation, "b");
    expect((await reservationDoc(reservation.reservationId)).status).toBe("RELEASED");
    expect(readOnlySource.release).not.toHaveBeenCalled();
  });
});

describe("cart items and their reservations (ECOMAPI-74)", () => {
  const USER = "user-reservations";
  const server = new ApolloServer({ typeDefs, resolvers });
  const run = async (query, variables) => {
    const response = await server.executeOperation(
      { query, variables },
      { contextValue: { user: { uid: USER }, loaders: createLoaders() } }
    );
    return response.body.singleResult;
  };
  const errorOf = (result) => result.errors?.[0]?.extensions;
  const cartIds = [];
  const orderIds = [];
  const newCart = () => {
    const id = `cart-reservations-${randomUUID()}`;
    cartIds.push(id);
    return id;
  };
  const ADD = `mutation ($input: AddToCart!) { addToCart(input: $input) { data { id } } }`;
  const REMOVE = `mutation ($input: RemoveFromCart!) { removeFromCart(input: $input) { success } }`;
  const PAY = `mutation ($input: CreateOrderPayment!) { createOrderPayment(input: $input) { success } }`;
  const itemData = async (id) => (await db.collection("cartItems").doc(id).get()).data();

  const payableOrder = async (cartId) => {
    const created = await run(`mutation ($input: CreateOrder!) { createOrder(input: $input) { data { id } } }`, {
      input: { cartId },
    });
    const orderId = created.data.createOrder.data.id;
    orderIds.push(orderId);
    await run(`mutation ($input: UpdateOrder!) { updateOrder(input: $input) { success } }`, {
      input: {
        id: orderId,
        customer: { email: "r@example.com", name: "Reservations", phone: "5555555555" },
        address: {
          address: "Calle 1",
          zipCode: "01000",
          coords: { latitude: 1, longitude: 1, latitudeDelta: 1, longitudeDelta: 1 },
        },
      },
    });
    return orderId;
  };

  afterAll(async () => {
    await Promise.all(orderIds.map((id) => db.collection("orders").doc(id).delete()));
    for (const cartId of cartIds) {
      const items = await db.collection("cartItems").where("cartId", "==", cartId).get();
      await Promise.all(items.docs.map((doc) => doc.ref.delete()));
    }
  });

  it("addToCart reserves under the item's key and removeFromCart releases it", async () => {
    const id = await newProduct(10);
    const cartId = newCart();
    const added = await run(ADD, { input: { cartId, productId: toGlobalProductId("fs", id), quantity: 2 } });
    const itemId = added.data.addToCart.data.id;

    const [held] = (await itemData(itemId)).reservations;
    expect(held).toMatchObject({ reservationId: `cartItem-${itemId}-reserve`, quantity: 2 });
    expect((await reservationDoc(held.reservationId)).status).toBe("HELD");
    expect(await stockOf(id)).toBe(8);

    await run(REMOVE, { input: { id: itemId } });
    expect((await reservationDoc(held.reservationId)).status).toBe("RELEASED");
    expect(await stockOf(id)).toBe(10);
  });

  it("an item added to twice keeps one reservation per addition and releases both", async () => {
    const id = await newProduct(10);
    const cartId = newCart();
    const input = { cartId, productId: toGlobalProductId("fs", id), quantity: 1 };
    const first = await run(ADD, { input });
    await run(ADD, { input: { ...input, quantity: 2 } });
    const itemId = first.data.addToCart.data.id;

    expect((await itemData(itemId)).reservations.map((r) => r.quantity)).toEqual([1, 2]);
    expect(await stockOf(id)).toBe(7);
    await run(REMOVE, { input: { id: itemId } });
    expect(await stockOf(id)).toBe(10);
  });

  it("an item from before reservations gives back its old units and its new ones", async () => {
    const id = await newProduct(8);
    const cartId = newCart();
    // As addToCart wrote it before reservations: 2 units already out of stock.
    const legacy = await db.collection("cartItems").add({
      cartId,
      orderId: null,
      userId: USER,
      productId: toGlobalProductId("fs", id),
      quantity: 2,
      unitPrice: 100,
      subtotal: 200,
    });
    await run(ADD, { input: { cartId, productId: toGlobalProductId("fs", id), quantity: 1 } });
    expect(await stockOf(id)).toBe(7);

    await run(REMOVE, { input: { id: legacy.id } });
    expect(await stockOf(id)).toBe(10);
  });

  it("cancelling an order releases its reservations once", async () => {
    const id = await newProduct(10);
    const cartId = newCart();
    const added = await run(ADD, { input: { cartId, productId: toGlobalProductId("fs", id), quantity: 3 } });
    const orderId = await payableOrder(cartId);
    const [held] = (await itemData(added.data.addToCart.data.id)).reservations;

    const CANCEL = `mutation ($input: CancelOrder!) { cancelOrder(input: $input) { success } }`;
    await run(CANCEL, { input: { id: orderId } });
    await run(CANCEL, { input: { id: orderId } });

    expect((await reservationDoc(held.reservationId)).status).toBe("RELEASED");
    expect(await stockOf(id)).toBe(10);
  });

  it("createOrderPayment refuses an expired reservation until the item is reserved again", async () => {
    const id = await newProduct(10);
    const productId = toGlobalProductId("fs", id);
    const cartId = newCart();
    const added = await run(ADD, { input: { cartId, productId, quantity: 1 } });
    const itemId = added.data.addToCart.data.id;
    const orderId = await payableOrder(cartId);

    const item = await itemData(itemId);
    await db.collection("cartItems").doc(itemId).update({
      reservations: item.reservations.map((r) => ({ ...r, expiresAt: new Date(Date.now() - 1000) })),
    });
    payment.createPayment.mockClear();

    const refused = await run(PAY, { input: { orderId } });
    expect(errorOf(refused)).toMatchObject({
      code: "BAD_USER_INPUT",
      invalidArgument: "orderId",
      expiredItemIds: [itemId],
    });
    expect(payment.createPayment).not.toHaveBeenCalled();

    // What the app does: take the item out and add it back to the order.
    await run(REMOVE, { input: { id: itemId } });
    await run(ADD, { input: { cartId, orderId, productId, quantity: 1 } });
    const paid = await run(PAY, { input: { orderId } });
    expect(paid.errors).toBeUndefined();
    expect(payment.createPayment).toHaveBeenCalledTimes(1);
    expect(await stockOf(id)).toBe(9);
  });
});
