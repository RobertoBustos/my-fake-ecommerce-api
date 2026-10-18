import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "crypto";
import db from "../src/config/firestore.js";
import * as transactions from "../src/db/transactions.js";
import { addToCart } from "../src/db/cart.js";

// The stock is reserved in the product's source before the cart write, so a
// cart write that fails must put the units back (ECOMAPI-72).
describe("addToCart releases the reservation when the cart write fails", () => {
  const productId = `test-compensation-${randomUUID()}`;

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.collection("products").doc(productId).delete();
  });

  it("returns the units and rethrows the error", async () => {
    await db.collection("products").doc(productId).set({ stock: 5 });
    const realRunTransaction = transactions.runTransaction;
    vi.spyOn(transactions, "runTransaction")
      // The reservation goes through...
      .mockImplementationOnce(realRunTransaction)
      // ...the cart write fails...
      .mockImplementationOnce(() => Promise.reject(new Error("cart write failed")))
      // ...and the release goes through again.
      .mockImplementation(realRunTransaction);

    await expect(
      addToCart(
        { id: productId, unitPrice: 100 },
        { cartId: `cart-compensation-${randomUUID()}`, productId, quantity: 2 },
        "user-compensation"
      )
    ).rejects.toThrow("cart write failed");

    expect((await db.collection("products").doc(productId).get()).get("stock")).toBe(5);
  });
});
