import { describe, it, expect, vi, afterEach } from "vitest";
import { createOrder, updateOrder, cancelOrder, deleteOrder } from "../src/db/orders.js";

vi.mock("../src/db/payment.js", () => ({
  cancelPayment: vi.fn(),
  getCustomer: vi.fn(),
}));

import { cancelPayment } from "../src/db/payment.js";

// orders.js now genuinely reads/writes the "orders" collection on the
// Firestore emulator; we clean up what each test creates to avoid leaving
// junk between runs.
async function removeOrder(id) {
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
    const order = await createOrder({ cartId: "cart-h7-test" });
    createdOrderId = order.id;
    // createOrder leaves paymentId as null.

    const result = await cancelOrder({ id: order.id });

    expect(result).toBe(true);
    expect(cancelPayment).not.toHaveBeenCalled();
  });
});
