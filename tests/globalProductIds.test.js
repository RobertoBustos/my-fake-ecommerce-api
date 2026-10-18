import { describe, it, expect, vi, afterAll, beforeAll } from "vitest";
import { randomUUID } from "crypto";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";
import { createLoaders } from "../src/dataloaders/index.js";
import db from "../src/config/firestore.js";
import { indexFirestoreProducts, unindexFirestoreProducts } from "./helpers/catalogIndex.js";
import {
  canonicalProductId,
  getCatalogProduct,
  parseProductId,
  resolveProductId,
  toGlobalProductId,
} from "../src/catalog/index.js";

const { payment } = vi.hoisted(() => ({
  payment: {
    cancelPayment: vi.fn().mockResolvedValue(true),
    createPayment: vi.fn().mockResolvedValue({
      paymentId: "pi_global_ids",
      clientSecret: "secret",
      ephimeralKey: "ek",
    }),
    getCustomer: vi.fn().mockResolvedValue({ id: "cus_global_ids" }),
    searchPayment: vi.fn().mockResolvedValue(null),
    searchPaymentMethod: vi.fn(),
  },
}));
vi.mock("../src/db/payment.js", () => payment);

const USER = "user-global-ids";
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
  addToCart(input: $input) { success data { id productId product { id source } } }
}`;

describe("product id parser (ECOMAPI-73)", () => {
  it("round-trips a global id", () => {
    const id = toGlobalProductId("mysql-outlet", "42");
    expect(id).not.toContain(":");
    expect(parseProductId(id)).toEqual({ sourceKey: "mysql-outlet", localId: "42" });
  });

  it("keeps everything after the first colon in the local id", () => {
    const id = toGlobalProductId("fs", "a:b");
    expect(parseProductId(id)).toEqual({ sourceKey: "fs", localId: "a:b" });
  });

  it("reads an id without a prefix as a Firestore id", () => {
    expect(parseProductId("1")).toEqual({ sourceKey: "fs", localId: "1" });
    expect(parseProductId("test-stock-abc")).toEqual({ sourceKey: "fs", localId: "test-stock-abc" });
    expect(canonicalProductId("1")).toBe(toGlobalProductId("fs", "1"));
    expect(canonicalProductId(toGlobalProductId("fs", "1"))).toBe(toGlobalProductId("fs", "1"));
  });

  it("answers NOT_FOUND for an id of an unknown source", async () => {
    const id = toGlobalProductId("mysql-outlet", "42");
    const notFound = expect.objectContaining({
      extensions: expect.objectContaining({ code: "NOT_FOUND", invalidArgument: "productId" }),
    });
    expect(() => resolveProductId(id)).toThrow(notFound);
    await expect(getCatalogProduct(id)).rejects.toThrow(notFound);
  });
});

describe("global product ids through the API (ECOMAPI-73)", () => {
  const localId = `test-global-${randomUUID()}`;
  const globalId = toGlobalProductId("fs", localId);
  const cartId = `cart-global-${randomUUID()}`;

  beforeAll(async () => {
    await db.collection("products").doc(localId).set({
      title: "Global id fixture",
      description: "",
      category: "test-global-ids",
      image: "https://example.com/fixture.png",
      currency: "MXN",
      unitPrice: 1000,
      purchaseLimits: { min: 1, max: 10 },
      stock: 10,
    });
    await indexFirestoreProducts(localId);
  });

  afterAll(async () => {
    await db.collection("products").doc(localId).delete();
    await unindexFirestoreProducts(localId);
    const items = await db.collection("cartItems").where("cartId", "==", cartId).get();
    await Promise.all(items.docs.map((doc) => doc.ref.delete()));
  });

  it("lists products with their global id and source", async () => {
    const result = await run(`query ($id: ID) {
      products(id: $id) { edges { node { id source title } } }
    }`, { id: globalId });

    expect(result.errors).toBeUndefined();
    expect(result.data.products.edges).toEqual([
      { node: { id: globalId, source: "Main catalog", title: "Global id fixture" } },
    ]);
  });

  it("still finds a product by its id from before global ids", async () => {
    const result = await run(`query ($id: ID) { products(id: $id) { edges { node { id } } } }`, {
      id: localId,
    });
    expect(result.data.products.edges).toEqual([{ node: { id: globalId } }]);
  });

  it("answers NOT_FOUND when listing an id of an unknown source", async () => {
    const result = await run(`query ($id: ID) { products(id: $id) { edges { node { id } } } }`, {
      id: toGlobalProductId("mysql-outlet", "42"),
    });
    expect(errorOf(result)).toMatchObject({ code: "NOT_FOUND" });
  });

  it("stores the global id and a copy of the product, whichever id the client sent", async () => {
    const first = await run(ADD_TO_CART, { input: { cartId, productId: globalId, quantity: 1 } });
    const second = await run(ADD_TO_CART, { input: { cartId, productId: localId, quantity: 2 } });

    expect(first.errors).toBeUndefined();
    expect(second.errors).toBeUndefined();
    // Both forms are the same product, so they land on the same item.
    expect(second.data.addToCart.data.id).toBe(first.data.addToCart.data.id);
    expect(second.data.addToCart.data).toMatchObject({
      productId: globalId,
      product: { id: globalId, source: "Main catalog" },
    });

    const stored = (await db.collection("cartItems").doc(first.data.addToCart.data.id).get()).data();
    expect(stored).toMatchObject({
      productId: globalId,
      sourceKey: "fs",
      title: "Global id fixture",
      image: "https://example.com/fixture.png",
      currency: "MXN",
      quantity: 3,
      unitPrice: 1000,
      subtotal: 3000,
    });
    expect((await db.collection("products").doc(localId).get()).get("stock")).toBe(7);
  });

  it("filters a cart by product with either id form", async () => {
    const query = `query ($cartId: String, $productId: String) {
      carts(cartId: $cartId, productId: $productId) { edges { node { productId } } }
    }`;
    for (const productId of [globalId, localId]) {
      const result = await run(query, { cartId, productId });
      expect(result.data.carts.edges).toEqual([{ node: { productId: globalId } }]);
    }
  });

  it("puts the units back in their source when the item is removed", async () => {
    const [item] = (await db.collection("cartItems").where("cartId", "==", cartId).get()).docs;
    const result = await run(`mutation ($input: RemoveFromCart!) {
      removeFromCart(input: $input) { success }
    }`, { input: { id: item.id } });

    expect(result.data.removeFromCart.success).toBe(true);
    expect((await db.collection("products").doc(localId).get()).get("stock")).toBe(10);
  });
});

describe("createOrderPayment with a changed price (ECOMAPI-73)", () => {
  const localId = `test-reprice-${randomUUID()}`;
  const globalId = toGlobalProductId("fs", localId);
  const cartId = `cart-reprice-${randomUUID()}`;
  let orderId;

  beforeAll(async () => {
    await db.collection("products").doc(localId).set({
      title: "Reprice fixture",
      description: "",
      category: "test-reprice",
      image: "",
      currency: "MXN",
      unitPrice: 1000,
      purchaseLimits: { min: 1, max: 10 },
      stock: 10,
    });
    await run(ADD_TO_CART, { input: { cartId, productId: globalId, quantity: 2 } });
    const created = await run(`mutation ($input: CreateOrder!) {
      createOrder(input: $input) { data { id } }
    }`, { input: { cartId } });
    orderId = created.data.createOrder.data.id;
    await run(`mutation ($input: UpdateOrder!) { updateOrder(input: $input) { success } }`, {
      input: {
        id: orderId,
        customer: { email: "r@example.com", name: "Reprice", phone: "5555555555" },
        address: {
          address: "Calle 1",
          zipCode: "01000",
          coords: { latitude: 1, longitude: 1, latitudeDelta: 1, longitudeDelta: 1 },
        },
      },
    });
  });

  afterAll(async () => {
    await db.collection("products").doc(localId).delete();
    await db.collection("orders").doc(orderId).delete();
    const items = await db.collection("cartItems").where("cartId", "==", cartId).get();
    await Promise.all(items.docs.map((doc) => doc.ref.delete()));
  });

  const PAY = `mutation ($input: CreateOrderPayment!) { createOrderPayment(input: $input) { success } }`;

  it("doesn't charge the old price, moves the items to the new one, then charges it", async () => {
    await db.collection("products").doc(localId).update({ unitPrice: 1200 });
    payment.createPayment.mockClear();

    const refused = await run(PAY, { input: { orderId } });
    expect(errorOf(refused)).toMatchObject({
      code: "BAD_USER_INPUT",
      invalidArgument: "orderId",
      priceChanges: [{ productId: globalId, previousUnitPrice: 1000, unitPrice: 1200 }],
    });
    expect(payment.createPayment).not.toHaveBeenCalled();

    const [item] = (await db.collection("cartItems").where("orderId", "==", orderId).get()).docs;
    expect(item.data()).toMatchObject({ unitPrice: 1200, subtotal: 2400 });

    const paid = await run(PAY, { input: { orderId } });
    expect(paid.errors).toBeUndefined();
    // 2400 plus 16% tax.
    expect(payment.createPayment).toHaveBeenCalledWith(orderId, 2784, "cus_global_ids", "MXN");
  });
});
