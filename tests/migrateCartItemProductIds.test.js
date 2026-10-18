import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import db from "../src/config/firestore.js";
import { toGlobalProductId } from "../src/catalog/index.js";
import { migrateCartItemProductIds } from "../scripts/migrateCartItemProductIds.js";

describe("migrateCartItemProductIds script (ECOMAPI-73)", () => {
  const suffix = randomUUID();
  const productId = `migrate-product-${suffix}`;
  const globalId = toGlobalProductId("fs", productId);
  const cartIds = ["legacy", "deleted", "migrated"].map((name) => `migrate-${name}-${suffix}`);
  const [legacyCart, deletedCart, migratedCart] = cartIds;
  const itemIds = {};

  const seedItem = async (key, cartId, fields) => {
    const ref = await db.collection("cartItems").add({
      cartId,
      orderId: null,
      userId: "user-migrate",
      quantity: 2,
      unitPrice: 500,
      subtotal: 1000,
      ...fields,
    });
    itemIds[key] = ref.id;
  };
  const itemData = async (key) => (await db.collection("cartItems").doc(itemIds[key]).get()).data();

  beforeAll(async () => {
    await db.collection("products").doc(productId).set({
      title: "Migrate fixture",
      description: "",
      category: "test",
      image: "https://example.com/migrate.png",
      currency: "MXN",
      unitPrice: 500,
      purchaseLimits: { min: 1, max: 10 },
      stock: 10,
    });
    await seedItem("legacy", legacyCart, { productId });
    await seedItem("deleted", deletedCart, { productId: `gone-${suffix}` });
    await seedItem("migrated", migratedCart, {
      productId: globalId,
      sourceKey: "fs",
      title: "Kept title",
      image: "kept.png",
      currency: "MXN",
    });
  });

  afterAll(async () => {
    await Promise.all([
      db.collection("products").doc(productId).delete(),
      ...Object.values(itemIds).map((id) => db.collection("cartItems").doc(id).delete()),
    ]);
  });

  it("a dry run reports what it would change and writes nothing", async () => {
    const result = await migrateCartItemProductIds({ cartIds });

    expect(result.scanned).toBe(3);
    expect(result.pending.map(({ item }) => item.id).sort()).toEqual(
      [itemIds.legacy, itemIds.deleted].sort()
    );
    expect(result.missingProducts).toEqual([itemIds.deleted]);
    expect(result.written).toBe(0);
    expect((await itemData("legacy")).productId).toBe(productId);
  });

  it("--apply rewrites the ids and fills in the copy where the product exists", async () => {
    const result = await migrateCartItemProductIds({ apply: true, cartIds });

    expect(result.written).toBe(2);
    expect(await itemData("legacy")).toMatchObject({
      productId: globalId,
      sourceKey: "fs",
      title: "Migrate fixture",
      image: "https://example.com/migrate.png",
      currency: "MXN",
      unitPrice: 500,
      subtotal: 1000,
    });
    const deleted = await itemData("deleted");
    expect(deleted).toMatchObject({
      productId: toGlobalProductId("fs", `gone-${suffix}`),
      sourceKey: "fs",
    });
    expect(deleted).not.toHaveProperty("title");
    expect(await itemData("migrated")).toMatchObject({ title: "Kept title", image: "kept.png" });
  });

  it("a second run finds nothing left to do", async () => {
    const result = await migrateCartItemProductIds({ apply: true, cartIds });
    expect(result.pending).toEqual([]);
    expect(result.written).toBe(0);
  });
});
