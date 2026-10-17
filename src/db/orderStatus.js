// The only status changes an order allows:
//   INCOMPLETE -> PAYMENT_PENDING               updateOrder, once customer and address are set
//   INCOMPLETE | PAYMENT_PENDING -> CANCELLED   cancelOrder
//   PAYMENT_PENDING -> COMPLETE                 only the Stripe webhook
// COMPLETE and CANCELLED are final: their items, details and stock are settled.
const OPEN_STATUSES = new Set(["INCOMPLETE", "PAYMENT_PENDING"]);

export const isOrderOpen = (order) => OPEN_STATUSES.has(order.status);
