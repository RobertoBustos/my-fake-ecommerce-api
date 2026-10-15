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

// El límite real es el menor entre purchaseLimits.max y el stock disponible:
// no tiene sentido dejar comprar más de lo que hay, aunque el producto lo permita.
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
