import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";
import { createLoaders } from "../src/dataloaders/index.js";
import db from "../src/config/firestore.js";
import { toGlobalProductId } from "../src/catalog/index.js";
import { firestoreCatalogSource } from "../src/catalog/sources/firestore/adapter.js";
import * as catalogIndex from "../src/db/catalogIndex.js";
import * as productsDb from "../src/db/products.js";
import { logger } from "../src/utils/logger.js";
import { indexFirestoreProducts, unindexFirestoreProducts } from "./helpers/catalogIndex.js";

const USER = "user-catalog-index";
const server = new ApolloServer({ typeDefs, resolvers });
const run = async (query, variables) => {
  const response = await server.executeOperation(
    { query, variables },
    { contextValue: { user: { uid: USER }, loaders: createLoaders() } }
  );
  return response.body.singleResult;
};
const errorOf = (result) => result.errors?.[0]?.extensions;

const LIST_ONE = `query ($id: ID) { products(id: $id) { edges { node { id title stock source } } } }`;
const ADD_TO_CART = `mutation ($input: AddToCart!) {
  addToCart(input: $input) { success data { id product { id title } } }
}`;

describe("products query and product loader from the catalog index (ECOMAPI-78)", () => {
  const localId = `test-index-${randomUUID()}`;
  const globalId = toGlobalProductId("fs", localId);
  const cartIds = [];
  const original = process.env.CATALOG_SOURCES;

  beforeAll(async () => {
    await db.collection("products").doc(localId).set({
      title: "Index fixture",
      description: "",
      category: "electronics",
      image: "",
      currency: "MXN",
      unitPrice: 1200,
      purchaseLimits: { min: 1, max: 5 },
      stock: 8,
      updatedAt: new Date(),
    });
    await indexFirestoreProducts(localId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.CATALOG_SOURCES;
    else process.env.CATALOG_SOURCES = original;
  });

  afterAll(async () => {
    await db.collection("products").doc(localId).delete();
    await unindexFirestoreProducts(localId);
    for (const cartId of cartIds) {
      const items = await db.collection("cartItems").where("cartId", "==", cartId).get();
      await Promise.all(items.docs.map((doc) => doc.ref.delete()));
    }
  });

  it("lists products without reading any source", async () => {
    const sourceReads = [
      vi.spyOn(firestoreCatalogSource, "getProducts"),
      vi.spyOn(firestoreCatalogSource, "listChanged"),
      vi.spyOn(productsDb, "getProductsByIds"),
    ];
    const page = await run(`query { products(first: 5) { edges { node { id } } pageInfo { hasNextPage } } }`);
    expect(page.errors).toBeUndefined();
    expect(page.data.products.edges.length).toBeGreaterThan(0);

    const one = await run(LIST_ONE, { id: globalId });
    expect(one.data.products.edges).toEqual([
      { node: { id: globalId, title: "Index fixture", stock: 8, source: "Main catalog" } },
    ]);
    for (const spy of sourceReads) expect(spy).not.toHaveBeenCalled();
  });

  it("shows what the index holds until the next sync, not the source's latest", async () => {
    await db.collection("products").doc(localId).update({ title: "Renamed in the source" });
    const listed = await run(LIST_ONE, { id: globalId });
    expect(listed.data.products.edges[0].node.title).toBe("Index fixture");

    await indexFirestoreProducts(localId);
    const synced = await run(LIST_ONE, { id: globalId });
    expect(synced.data.products.edges[0].node.title).toBe("Renamed in the source");
    await db.collection("products").doc(localId).update({ title: "Index fixture" });
    await indexFirestoreProducts(localId);
  });

  it("doesn't list the products of a switched-off source", async () => {
    process.env.CATALOG_SOURCES = "other";
    const page = await run(`query { products(first: 100) { edges { node { id } } } }`);
    expect(page.errors).toBeUndefined();
    expect(page.data.products.edges).toEqual([]);
    expect(errorOf(await run(LIST_ONE, { id: globalId }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps listing a product whose source is down, and addToCart answers CONFLICT with retryable", async () => {
    vi.spyOn(firestoreCatalogSource, "getProducts").mockRejectedValue(new Error("connection refused"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const listed = await run(LIST_ONE, { id: globalId });
    expect(listed.data.products.edges).toHaveLength(1);

    const cartId = `cart-index-${randomUUID()}`;
    cartIds.push(cartId);
    const added = await run(ADD_TO_CART, { input: { cartId, productId: globalId, quantity: 1 } });
    expect(errorOf(added)).toMatchObject({ code: "CONFLICT", retryable: true });
    expect(warn).toHaveBeenCalledWith("Catalog source call failed", {
      sourceKey: "fs",
      error: "connection refused",
    });
  });

  it("answers CONFLICT with retryable when the source fails to reserve, leaving the stock alone", async () => {
    vi.spyOn(firestoreCatalogSource, "reserve").mockRejectedValue(new Error("deadline exceeded"));
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const cartId = `cart-index-${randomUUID()}`;
    cartIds.push(cartId);

    const added = await run(ADD_TO_CART, { input: { cartId, productId: globalId, quantity: 1 } });
    expect(errorOf(added)).toMatchObject({ code: "CONFLICT", retryable: true });
    expect((await db.collection("products").doc(localId).get()).get("stock")).toBe(8);
  });

  it("loads CartItem.product from the index, and from the source for a product not indexed yet", async () => {
    const cartId = `cart-index-${randomUUID()}`;
    cartIds.push(cartId);
    const added = await run(ADD_TO_CART, { input: { cartId, productId: globalId, quantity: 1 } });
    expect(added.errors).toBeUndefined();
    expect(added.data.addToCart.data.product).toEqual({ id: globalId, title: "Index fixture" });

    const entries = vi.spyOn(catalogIndex, "getCatalogEntries");
    const live = vi.spyOn(productsDb, "getProductsByIds");
    const cart = await run(`query ($id: String) { carts(cartId: $id) { edges { node { product { id } } } } }`, {
      id: cartId,
    });
    expect(cart.errors).toBeUndefined();
    expect(cart.data.carts.edges[0].node.product.id).toBe(globalId);
    expect(entries).toHaveBeenCalledTimes(1);
    expect(live).not.toHaveBeenCalled();

    await unindexFirestoreProducts(localId);
    try {
      const fallback = await run(`query ($id: String) { carts(cartId: $id) { edges { node { product { id } } } } }`, {
        id: cartId,
      });
      expect(fallback.data.carts.edges[0].node.product.id).toBe(globalId);
      expect(live).toHaveBeenCalledTimes(1);
    } finally {
      await indexFirestoreProducts(localId);
    }
  });
});
