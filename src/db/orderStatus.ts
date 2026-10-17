// The only status changes an order allows:
//   INCOMPLETE -> PAYMENT_PENDING               updateOrder, once customer and address are set
//   INCOMPLETE | PAYMENT_PENDING -> CANCELLED   cancelOrder
//   PAYMENT_PENDING -> COMPLETE                 only the Stripe webhook
// COMPLETE and CANCELLED are final: their items, details and stock are settled.
import type { Order, OrderStatus } from "../types/models.js";

export const OPEN_STATUSES: OrderStatus[] = ["INCOMPLETE", "PAYMENT_PENDING"];

export const isOrderOpen = (order: Pick<Order, "status">): boolean =>
  OPEN_STATUSES.includes(order.status);
