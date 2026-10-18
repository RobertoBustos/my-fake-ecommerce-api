import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import db from "../src/config/firestore.js";
import { toGlobalProductId } from "../src/catalog/index.js";
import { addToCart, InsufficientStockError } from "../src/db/cart.js";
import { TransactionContentionError } from "../src/db/transactions.js";

describe("addToCart - stock transaction", () => {
  const productId = `test-stock-${randomUUID()}`;
  const product = { id: productId, unitPrice: 100 };
  // Items are stored under the product's global id.
  const storedProductId = toGlobalProductId("fs", productId);
  const STOCK = 10;
  const CONCURRENT_PURCHASES = 20;

  afterAll(async () => {
    await db.collection("products").doc(productId).delete();
    const cartItems = await db
      .collection("cartItems")
      .where("productId", "==", storedProductId)
      .get();
    await Promise.all(cartItems.docs.map((doc) => doc.ref.delete()));
  });

  // How many of the 20 succeed depends on lock timing (a cold emulator loses
  // more lock fights), so the test checks what must always hold instead of an
  // exact count: no overselling, no lost updates, and only expected failures.
  it("20 simultaneous purchases never oversell and never lose an update", async () => {
    await db
      .collection("products")
      .doc(productId)
      .set({ stock: STOCK, purchaseLimits: { min: 1, max: STOCK } });

    const attempts = Array.from({ length: CONCURRENT_PURCHASES }, (_, i) =>
      addToCart(
        product,
        { cartId: `cart-stock-test-${i}-${randomUUID()}`, productId, quantity: 1 },
        "user-stock"
      )
    );
    const results = await Promise.allSettled(attempts);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    expect(succeeded.length).toBeGreaterThan(0);
    expect(succeeded.length).toBeLessThanOrEqual(STOCK);
    failed.forEach((r) => {
      expect([InsufficientStockError, TransactionContentionError]).toContain(
        r.reason.constructor
      );
    });

    // Every successful purchase took exactly one unit, and nothing else did.
    const finalDoc = await db.collection("products").doc(productId).get();
    expect(finalDoc.data().stock).toBe(STOCK - succeeded.length);
    const cartItems = await db
      .collection("cartItems")
      .where("productId", "==", storedProductId)
      .get();
    expect(cartItems.size).toBe(succeeded.length);

    // With stock left over, every failure must have been contention, never a
    // false "out of stock".
    if (finalDoc.data().stock > 0) {
      failed.forEach((r) => expect(r.reason).toBeInstanceOf(TransactionContentionError));
    }
  }, 60000);
});
