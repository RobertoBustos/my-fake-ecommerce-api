import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "crypto";
import db from "../src/config/firestore.js";
import { addToCart, removeFromCart, updateCartItems } from "../src/db/cart.js";
import {
  cancelOrder,
  createOrder,
  deleteOrder,
  OrderAlreadyCompleteError,
} from "../src/db/orders.js";

vi.mock("../src/db/payment.js", () => ({
  cancelPayment: vi.fn(),
  getCustomer: vi.fn(),
}));

const { cancelPayment } = await import("../src/db/payment.js");

const STOCK = 50;
const created = { products: [], orders: [], carts: [] };

const newProduct = async () => {
  const id = `test-restock-${randomUUID()}`;
  await db.collection("products").doc(id).set({
    stock: STOCK,
    purchaseLimits: { min: 1, max: STOCK },
  });
  created.products.push(id);
  return { id, unitPrice: 100 };
};

const stockOf = async (productId) =>
  (await db.collection("products").doc(productId).get()).data().stock;

const orderWithItems = async (lines, { paymentId = null } = {}) => {
  const cartId = `cart-restock-${randomUUID()}`;
  created.carts.push(cartId);
  for (const { product, quantity } of lines) {
    await addToCart(product, { cartId, productId: product.id, quantity }, "user-restock");
  }
  const order = await createOrder({ cartId }, "user-restock");
  created.orders.push(order.id);
  await updateCartItems(cartId, order.id);
  if (paymentId) {
    await db.collection("orders").doc(order.id).update({ paymentId });
  }
  return order;
};

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(created.orders.map((id) => deleteOrder(id)));
  for (const cartId of created.carts) {
    const items = await db.collection("cartItems").where("cartId", "==", cartId).get();
    await Promise.all(items.docs.map((doc) => doc.ref.delete()));
  }
  await Promise.all(created.products.map((id) => db.collection("products").doc(id).delete()));
  created.products = [];
  created.orders = [];
  created.carts = [];
});

describe("removeFromCart restock", () => {
  it("puts the item's units back in stock and deletes the item", async () => {
    const product = await newProduct();
    const cartId = `cart-restock-${randomUUID()}`;
    created.carts.push(cartId);
    const item = await addToCart(
      product,
      { cartId, productId: product.id, quantity: 3 },
      "user-restock"
    );
    expect(await stockOf(product.id)).toBe(STOCK - 3);

    const result = await removeFromCart({ id: item.id }, "user-restock");

    expect(result).toBe(true);
    expect(await stockOf(product.id)).toBe(STOCK);
    expect((await db.collection("cartItems").doc(item.id).get()).exists).toBe(false);
  });

  it("returns false for an unknown item without touching stock", async () => {
    expect(await removeFromCart({ id: `missing-${randomUUID()}` }, "user-restock")).toBe(false);
  });
});

describe("cancelOrder restock", () => {
  it("returns every item's units to their products", async () => {
    const first = await newProduct();
    const second = await newProduct();
    const order = await orderWithItems([
      { product: first, quantity: 2 },
      { product: second, quantity: 5 },
    ]);
    expect(await stockOf(first.id)).toBe(STOCK - 2);
    expect(await stockOf(second.id)).toBe(STOCK - 5);

    expect(await cancelOrder({ id: order.id })).toBe(true);

    expect(await stockOf(first.id)).toBe(STOCK);
    expect(await stockOf(second.id)).toBe(STOCK);
    const saved = await db.collection("orders").doc(order.id).get();
    expect(saved.data().status).toBe("CANCELLED");
  });

  it("returns the stock only once when the order is cancelled twice", async () => {
    const product = await newProduct();
    const order = await orderWithItems([{ product, quantity: 4 }], { paymentId: "pi_restock" });

    await cancelOrder({ id: order.id });
    await cancelOrder({ id: order.id });

    expect(await stockOf(product.id)).toBe(STOCK);
    // The PaymentIntent is cancelled once, on the real status change.
    expect(cancelPayment).toHaveBeenCalledTimes(1);
  });

  it("refuses to cancel a paid order and leaves its stock sold", async () => {
    const product = await newProduct();
    const order = await orderWithItems([{ product, quantity: 2 }]);
    await db.collection("orders").doc(order.id).update({ status: "COMPLETE" });

    await expect(cancelOrder({ id: order.id })).rejects.toBeInstanceOf(
      OrderAlreadyCompleteError
    );

    expect(await stockOf(product.id)).toBe(STOCK - 2);
    const saved = await db.collection("orders").doc(order.id).get();
    expect(saved.data().status).toBe("COMPLETE");
  });
});
