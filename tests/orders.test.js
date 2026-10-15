import { describe, it, expect, afterEach } from "vitest";
import { createOrder, updateOrder, getOrders, saveOrders } from "../src/db/orders.js";

describe("updateOrder (H6)", () => {
  let createdOrderId;

  // orders.js lee/escribe src/data/orders.json de verdad; limpiamos lo que
  // la prueba crea para no dejar basura en el archivo.
  afterEach(async () => {
    if (!createdOrderId) return;
    const orders = await getOrders(null);
    await saveOrders(orders.filter((order) => order.id !== createdOrderId));
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
