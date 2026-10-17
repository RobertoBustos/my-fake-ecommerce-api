import DataLoader from "dataloader";
import { getCartByOrderIds } from "../db/cart.js";
import type { CartItem, OrderTotals } from "../types/models.js";
import { computeOrderTotals } from "../utils/orderTotals.js";

// New instance per request: batches the .load(orderId) calls made in the
// same tick into a single round of cartItems reads, instead of one query
// per order.
export const createOrderTotalsLoader = () =>
  new DataLoader<string, OrderTotals>(async (orderIds) => {
    const cartItems = await getCartByOrderIds(orderIds);
    const byOrderId = new Map<string | null, CartItem[]>();
    for (const item of cartItems) {
      if (!byOrderId.has(item.orderId)) {
        byOrderId.set(item.orderId, []);
      }
      byOrderId.get(item.orderId)?.push(item);
    }
    return orderIds.map((id) => computeOrderTotals(byOrderId.get(id) ?? []));
  });
