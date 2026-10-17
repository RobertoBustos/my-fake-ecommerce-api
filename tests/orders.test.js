import { describe, it, expect, vi, afterEach } from "vitest";
import { createOrder, updateOrder, cancelOrder, deleteOrder } from "../src/db/orders.js";

vi.mock("../src/db/payment.js", () => ({
  cancelPayment: vi.fn(),
  getCustomer: vi.fn(),
}));

import { cancelPayment } from "../src/db/payment.js";
import db from "../src/config/firestore.js";

// createOrder only orders a cart that has unordered items.
const seedCartItem = (cartId, userId = null) =>
  db.collection("cartItems").add({
    cartId,
    orderId: null,
    userId,
    productId: "fixture-product",
    quantity: 1,
    unitPrice: 100,
    subtotal: 100,
  });

const deleteCartItems = async (cartId) => {
  const items = await db.collection("cartItems").where("cartId", "==", cartId).get();
  await Promise.all(items.docs.map((doc) => doc.ref.delete()));
};

// orders.js now genuinely reads/writes the "orders" collection on the
// Firestore emulator; we clean up what each test creates to avoid leaving
// junk between runs.
async function removeOrder(id) {
  const order = await db.collection("orders").doc(id).get();
  await deleteCartItems(order.data().cart);
  await deleteOrder(id);
}

describe("updateOrder (H6)", () => {
  let createdOrderId;

  afterEach(async () => {
    if (!createdOrderId) return;
    await removeOrder(createdOrderId);
    createdOrderId = undefined;
  });

  it("accepts address alone without blowing up on an omitted customer", async () => {
    await seedCartItem("cart-h6-test");
    const order = await createOrder({ cartId: "cart-h6-test" });
    createdOrderId = order.id;

    const updated = await updateOrder({
      id: order.id,
      address: { address: "Av. Siempre Viva 742", zipCode: "00000" },
    });

    expect(updated.address).toEqual({ address: "Av. Siempre Viva 742", zipCode: "00000" });
    expect(updated.customer).toBeNull();
  });
});

describe("cancelOrder (H7)", () => {
  let createdOrderId;

  afterEach(async () => {
    vi.clearAllMocks();
    if (!createdOrderId) return;
    await removeOrder(createdOrderId);
    createdOrderId = undefined;
  });

  it("doesn't call Stripe when the order has no payment", async () => {
    await seedCartItem("cart-h7-test");
    const order = await createOrder({ cartId: "cart-h7-test" });
    createdOrderId = order.id;
    // createOrder leaves paymentId as null.

    const result = await cancelOrder({ id: order.id });

    expect(result).toBe(true);
    expect(cancelPayment).not.toHaveBeenCalled();
  });
});
