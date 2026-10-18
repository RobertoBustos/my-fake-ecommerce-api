import type { CartItem, OrderTotals } from "../types/models.js";

// Items written before prices carried a currency were in MXN.
const LEGACY_CURRENCY = "MXN";

// Totals are in the currency the items were priced in, which is the
// settlement currency when they were added. If the settlement currency
// changes while an order is open, createOrderPayment moves every item to the
// new one before charging, so what is charged is always in a single currency.
export const computeOrderTotals = (
  cartItems: Pick<CartItem, "quantity" | "subtotal" | "currency">[]
): OrderTotals => {
  const units = cartItems.reduce((acc, item) => acc + item.quantity, 0);
  const subtotal = cartItems.reduce((acc, item) => acc + item.subtotal, 0);
  const taxes = Math.floor(subtotal * 0.16);

  return {
    currency: cartItems.find((item) => item.currency)?.currency ?? LEGACY_CURRENCY,
    items: cartItems.length,
    units: units,
    subTotal: subtotal,
    taxes: taxes,
    discount: 0,
    total: subtotal + taxes,
  };
};
