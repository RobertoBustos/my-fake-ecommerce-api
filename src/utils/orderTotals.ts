import type { CartItem, OrderTotals } from "../types/models.js";

export const computeOrderTotals = (
  cartItems: Pick<CartItem, "quantity" | "subtotal">[]
): OrderTotals => {
  const units = cartItems.reduce((acc, item) => acc + item.quantity, 0);
  const subtotal = cartItems.reduce((acc, item) => acc + item.subtotal, 0);
  const taxes = Math.floor(subtotal * 0.16);

  return {
    currency: "MXN",
    items: cartItems.length,
    units: units,
    subTotal: subtotal,
    taxes: taxes,
    discount: 0,
    total: subtotal + taxes,
  };
};
