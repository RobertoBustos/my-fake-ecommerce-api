import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import db from "../src/config/firestore.js";
import { addToCart, InsufficientStockError } from "../src/db/cart.js";

describe("addToCart - stock transaction", () => {
  const productId = `test-stock-${randomUUID()}`;
  const product = { id: productId, unitPrice: 100 };
  const STOCK = 10;
  const CONCURRENT_PURCHASES = 20;

  afterAll(async () => {
    await db.collection("products").doc(productId).delete();
    const cartItems = await db
      .collection("cartItems")
      .where("productId", "==", productId)
      .get();
    await Promise.all(cartItems.docs.map((doc) => doc.ref.delete()));
  });

  it("20 simultaneous purchases never leave stock negative", async () => {
    // Firestore automatically retries conflicting transactions; with 20
    // concurrent writes to the same doc, that takes longer than Vitest's
    // default timeout.
    await db
      .collection("products")
      .doc(productId)
      .set({ stock: STOCK, purchaseLimits: { min: 1, max: STOCK } });

    const attempts = Array.from({ length: CONCURRENT_PURCHASES }, (_, i) =>
      addToCart(product, {
        cartId: `cart-stock-test-${i}`,
        productId,
        quantity: 1,
      })
    );
    const results = await Promise.allSettled(attempts);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    expect(succeeded).toHaveLength(STOCK);
    expect(failed).toHaveLength(CONCURRENT_PURCHASES - STOCK);
    failed.forEach((r) => {
      expect(r.reason).toBeInstanceOf(InsufficientStockError);
    });

    const finalDoc = await db.collection("products").doc(productId).get();
    expect(finalDoc.data().stock).toBe(0);
  }, 30000);
});
