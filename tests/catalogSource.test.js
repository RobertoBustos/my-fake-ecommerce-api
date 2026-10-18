import { describe, it, expect, afterEach, afterAll } from "vitest";
import { randomUUID } from "crypto";
import db from "../src/config/firestore.js";
import {
  DEFAULT_SOURCE_KEY,
  getCatalogProduct,
  getCatalogSource,
  OutOfStockError,
  toProduct,
} from "../src/catalog/index.js";
import { firestoreCatalogSource } from "../src/catalog/sources/firestore/adapter.js";

describe("catalog source registry (ECOMAPI-72)", () => {
  const original = process.env.CATALOG_SOURCES;
  afterEach(() => {
    if (original === undefined) delete process.env.CATALOG_SOURCES;
    else process.env.CATALOG_SOURCES = original;
  });

  it("serves the Firestore source under its key by default", () => {
    delete process.env.CATALOG_SOURCES;
    expect(DEFAULT_SOURCE_KEY).toBe("fs");
    expect(getCatalogSource("fs")).toBe(firestoreCatalogSource);
  });

  it("answers NOT_FOUND for a source it doesn't know", () => {
    expect(() => getCatalogSource("mysql-outlet")).toThrow(
      expect.objectContaining({ extensions: expect.objectContaining({ code: "NOT_FOUND" }) })
    );
  });

  it("answers NOT_FOUND for a known source that is switched off", () => {
    process.env.CATALOG_SOURCES = "other";
    expect(() => getCatalogSource("fs")).toThrow(
      expect.objectContaining({ extensions: expect.objectContaining({ code: "NOT_FOUND" }) })
    );
  });
});

describe("Firestore catalog source (ECOMAPI-72)", () => {
  const ids = [];
  const newProduct = async (stock) => {
    const id = `test-catalog-${randomUUID()}`;
    ids.push(id);
    await db.collection("products").doc(id).set({
      title: "Catalog fixture",
      description: "",
      category: "test",
      image: "",
      currency: "MXN",
      unitPrice: 1500,
      purchaseLimits: { min: 1, max: 10 },
      stock,
    });
    return id;
  };
  const stockOf = async (id) => (await db.collection("products").doc(id).get()).get("stock");

  afterAll(async () => {
    await Promise.all(ids.map((id) => db.collection("products").doc(id).delete()));
  });

  it("maps a product document to a SourceProduct and back to the API Product", async () => {
    const id = await newProduct(7);
    const [source] = await firestoreCatalogSource.getProducts([id, "missing-product"]);

    expect(source).toMatchObject({ localId: id, available: 7, unitPrice: 1500, updatedAt: null });
    expect(toProduct(source)).toMatchObject({ id, stock: 7, unitPrice: 1500 });
    expect(toProduct(source)).not.toHaveProperty("localId");
    expect(await getCatalogProduct(id)).toMatchObject({ id, stock: 7 });
    expect(await getCatalogProduct("missing-product")).toBeNull();
  });

  it("reserve takes units out of stock and release puts them back", async () => {
    const id = await newProduct(5);

    const reservation = await firestoreCatalogSource.reserve(id, 3, "test-reserve");
    expect(reservation).toEqual({ reservationId: "test-reserve", localId: id, quantity: 3, expiresAt: null });
    expect(await stockOf(id)).toBe(2);

    await firestoreCatalogSource.release(reservation, "test-release");
    expect(await stockOf(id)).toBe(5);
  });

  it("reserve refuses more units than there are, without touching the stock", async () => {
    const id = await newProduct(2);

    await expect(firestoreCatalogSource.reserve(id, 3, "too-many")).rejects.toBeInstanceOf(
      OutOfStockError
    );
    expect(await stockOf(id)).toBe(2);
  });

  it("release on a deleted product is a no-op", async () => {
    await expect(
      firestoreCatalogSource.release(
        { reservationId: "gone", localId: `missing-${randomUUID()}`, quantity: 1, expiresAt: null },
        "gone-release"
      )
    ).resolves.toBeUndefined();
  });

  it("listChanged pages through the catalog by document id", async () => {
    await newProduct(1);
    await newProduct(1);
    const seen = [];
    let cursor;
    do {
      const page = await firestoreCatalogSource.listChanged(null, { cursor, limit: 5 });
      expect(page.items.length).toBeLessThanOrEqual(5);
      expect(page.deletedIds).toEqual([]);
      seen.push(...page.items.map((item) => item.localId));
      cursor = page.nextCursor;
    } while (cursor);

    expect(new Set(seen).size).toBe(seen.length);
    for (const id of ids) expect(seen).toContain(id);
  });
});
