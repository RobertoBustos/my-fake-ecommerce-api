import { describe, it, expect, vi, afterEach } from "vitest";
import { createOrder, updateOrder, cancelOrder, getOrders, saveOrders } from "../src/db/orders.js";

vi.mock("../src/db/payment.js", () => ({
  cancelPayment: vi.fn(),
  getCustomer: vi.fn(),
}));

import { cancelPayment } from "../src/db/payment.js";

// orders.js lee/escribe src/data/orders.json de verdad; limpiamos lo que cada
// prueba crea para no dejar basura en el archivo.
async function removeOrder(id) {
  const orders = await getOrders(null);
  await saveOrders(orders.filter((order) => order.id !== id));
}

describe("updateOrder (H6)", () => {
  let createdOrderId;

  afterEach(async () => {
    if (!createdOrderId) return;
    await removeOrder(createdOrderId);
    createdOrderId = undefined;
  });

  it("acepta solo address, sin tronar por customer omitido", async () => {
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

  it("no llama a Stripe si la orden no tiene pago", async () => {
    const order = await createOrder({ cartId: "cart-h7-test" });
    createdOrderId = order.id;
    // createOrder deja paymentId en null.

    const result = await cancelOrder({ id: order.id });

    expect(result).toBe(true);
    expect(cancelPayment).not.toHaveBeenCalled();
  });
});
