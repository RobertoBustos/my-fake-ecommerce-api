import DataLoader from "dataloader";
import { getCartByOrderIds } from "../db/cart.js";
import { computeOrderTotals } from "../utils/orderTotals.js";

// Instancia nueva por request: agrupa los .load(orderId) del mismo tick en
// una sola tanda de lecturas de cartItems, en vez de una query por orden.
export const createOrderTotalsLoader = () =>
  new DataLoader(async (orderIds) => {
    const cartItems = await getCartByOrderIds(orderIds);
    const byOrderId = new Map();
    for (const item of cartItems) {
      if (!byOrderId.has(item.orderId)) {
        byOrderId.set(item.orderId, []);
      }
      byOrderId.get(item.orderId).push(item);
    }
    return orderIds.map((id) => computeOrderTotals(byOrderId.get(id) ?? []));
  });
