import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import db from "../src/config/firestore.js";
import { cleanupOrphanCartItems } from "../scripts/cleanupOrphanCartItems.js";
import { toGlobalProductId } from "../src/catalog/index.js";

describe("cleanupOrphanCartItems script (ECOMAPI-67)", () => {
  const suffix = randomUUID();
  const productId = `cleanup-product-${suffix}`;
  const cartIds = ["abandoned", "lost-order", "cancelled", "complete", "owned"].map(
    (name) => `cleanup-${name}-${suffix}`
  );
  const [abandonedCart, lostOrderCart, cancelledCart, completeCart, ownedCart] = cartIds;
  const orderIds = {};
  const itemIds = {};

  const productStock = async () =>
    (await db.collection("products").doc(productId).get()).data().stock;
  const itemExists = async (key) =>
    (await db.collection("cartItems").doc(itemIds[key]).get()).exists;

  const seedItem = async (key, cartId, { orderId = null, userId = null, quantity }) => {
    const ref = await db.collection("cartItems").add({
      cartId,
      orderId,
      userId,
      productId,
      quantity,
      unitPrice: 100,
      subtotal: 100 * quantity,
    });
    itemIds[key] = ref.id;
  };
  const seedOrder = async (key, cart, status) => {
    const ref = await db.collection("orders").add({ cart, status, userId: null });
    orderIds[key] = ref.id;
  };

  beforeAll(async () => {
    await db.collection("products").doc(productId).set({ title: "Cleanup fixture", stock: 10 });
    await seedOrder("cancelled", cancelledCart, "CANCELLED");
    await seedOrder("complete", completeCart, "COMPLETE");
    await seedItem("abandoned", abandonedCart, { quantity: 2 });
    await seedItem("lostOrder", lostOrderCart, { orderId: "order-that-was-deleted", quantity: 1 });
    await seedItem("cancelled", cancelledCart, { orderId: orderIds.cancelled, quantity: 3 });
    await seedItem("complete", completeCart, { orderId: orderIds.complete, quantity: 4 });
    await seedItem("owned", ownedCart, { userId: "someone", quantity: 5 });
  });

  afterAll(async () => {
    await Promise.all([
      db.collection("products").doc(productId).delete(),
      ...Object.values(orderIds).map((id) => db.collection("orders").doc(id).delete()),
      ...Object.values(itemIds).map((id) => db.collection("cartItems").doc(id).delete()),
    ]);
  });

  it("a dry run reports what it would release and writes nothing", async () => {
    const result = await cleanupOrphanCartItems({ cartIds });

    expect(result.toRelease.map((i) => i.id).sort()).toEqual(
      [itemIds.abandoned, itemIds.lostOrder].sort()
    );
    expect(result.unitsByProduct).toEqual({ [toGlobalProductId("fs", productId)]: 3 });
    expect(result.reportOnly.map((i) => i.orderStatus).sort()).toEqual(["CANCELLED", "COMPLETE"]);
    expect(result.released).toBe(0);
    expect(await productStock()).toBe(10);
    expect(await itemExists("abandoned")).toBe(true);
  });

  it("--apply deletes only the released items and returns their units once", async () => {
    const result = await cleanupOrphanCartItems({ apply: true, cartIds });

    expect(result.released).toBe(2);
    expect(await productStock()).toBe(13);
    expect(await itemExists("abandoned")).toBe(false);
    expect(await itemExists("lostOrder")).toBe(false);
    // Cancelled orders already got their stock back from cancelOrder.
    expect(await itemExists("cancelled")).toBe(true);
    expect(await itemExists("complete")).toBe(true);
    expect(await itemExists("owned")).toBe(true);
  });

  it("running --apply again changes nothing", async () => {
    const result = await cleanupOrphanCartItems({ apply: true, cartIds });

    expect(result.toRelease).toHaveLength(0);
    expect(result.released).toBe(0);
    expect(await productStock()).toBe(13);
  });
});
