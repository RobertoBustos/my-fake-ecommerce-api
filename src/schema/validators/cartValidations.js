import { z } from "zod";

const addToCartSchema = z.object({
  cartId: z.string().min(1),
  productId: z.string().min(1),
  orderId: z.string().optional().nullable(),
  quantity: z.number().int().positive(),
});

export const addToCartValidator = (input) => {
  return addToCartSchema.safeParse(input).success;
};

// The real limit is the lesser of purchaseLimits.max and the available stock:
// there's no point letting someone buy more than there is, even if the
// product's own limit would allow it.
export const validateCartQuantity = (quantity, product) => {
  const maxAllowed = Math.min(product.purchaseLimits.max, product.stock);
  return z.number().int().min(product.purchaseLimits.min).max(maxAllowed).safeParse(quantity).success;
};

export const removeFromCartValidator = (input) => {
  if (!input || !input.id || input.id === "") {
    return false;
  }
  return true;
};
