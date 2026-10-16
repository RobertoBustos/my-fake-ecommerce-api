import { getCart, searchPayment, searchPaymentMethod } from "../../db/index.js";

// Field resolvers are reads too, so like queries.js they may call db/.
export const CartItem = {
  product: async (parent, _args, context) => {
    return context.loaders.products.load(parent.productId);
  },
};

export const Order = {
  totals: async (parent, _args, context) => {
    return context.loaders.orderTotals.load(parent.id);
  },
  details: async (parent) => {
    const cart = await getCart({ orderId: parent.id });
    return cart;
  },
  payment: async (parent) => {
    if (parent.paymentId === null) return;
    const payment = await searchPayment("id", parent.paymentId);
    return payment;
  },
};

export const Payment = {
  paymentDetails: async (parent) => {
    if (parent.payment_method === null) return;
    const paymentMethod = await searchPaymentMethod(parent.payment_method);
    return paymentMethod;
  },
};
