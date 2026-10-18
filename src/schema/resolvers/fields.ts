import { getCart, searchPayment, searchPaymentMethod } from "../../db/index.js";
import type {
  CartItemResolvers,
  OrderResolvers,
  PaymentResolvers,
  ProductResolvers,
} from "../../generated/graphql.js";
import { LEGACY_CURRENCY } from "../../pricing/index.js";
import type { Product as ProductModel } from "../../types/models.js";

// Field resolvers are reads too, so like queries.ts they may call db/.
// A product is shown at its price in the settlement currency; unitPrice and
// currency come from the same per-request quote, so they always match.
export const Product: ProductResolvers = {
  unitPrice: async (parent, _args, context) =>
    (await context.loaders.displayPrices.load(parent)).unitPrice,
  currency: async (parent, _args, context) =>
    (await context.loaders.displayPrices.load(parent)).currency,
};

export const CartItem: CartItemResolvers = {
  currency: (parent) => parent.currency ?? LEGACY_CURRENCY,
  // The loader answers null for a deleted product; product is non-null in
  // the schema, so GraphQL reports that as a field error, as it always has.
  product: async (parent, _args, context) =>
    (await context.loaders.products.load(parent.productId)) as ProductModel,
};

export const Order: OrderResolvers = {
  totals: async (parent, _args, context) => {
    return context.loaders.orderTotals.load(parent.id);
  },
  details: async (parent) => {
    const cart = await getCart({ orderId: parent.id });
    return cart;
  },
  payment: async (parent) => {
    if (parent.paymentId === null) return null;
    return (await searchPayment("id", parent.paymentId)) ?? null;
  },
};

export const Payment: PaymentResolvers = {
  paymentDetails: async (parent) => {
    const method = parent.payment_method;
    if (method === null) return null;
    // Not expanded, so Stripe sends the id; the object form is only typed.
    return searchPaymentMethod(typeof method === "string" ? method : method.id);
  },
};
