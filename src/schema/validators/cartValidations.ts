import { z } from "zod";
import type { Product } from "../../types/models.js";
import { firstInvalidField } from "./validate.js";

const id = z.string().trim().min(1);

const addToCartSchema = z.object({
  cartId: id,
  productId: id,
  orderId: id.optional().nullable(),
  quantity: z.number().int().positive(),
});

const removeFromCartSchema = z.object({ id });

export type AddToCartInput = z.infer<typeof addToCartSchema>;
export type RemoveFromCartInput = z.infer<typeof removeFromCartSchema>;

export const checkAddToCart = (input: unknown) => firstInvalidField(addToCartSchema, input);

export const checkRemoveFromCart = (input: unknown) => firstInvalidField(removeFromCartSchema, input);

// The real limit is the lesser of purchaseLimits.max and the available stock:
// there's no point letting someone buy more than there is, even if the
// product's own limit would allow it.
export const validateCartQuantity = (
  quantity: number,
  product: Pick<Product, "purchaseLimits" | "stock">
): boolean => {
  const maxAllowed = Math.min(product.purchaseLimits.max, product.stock);
  return z.number().int().min(product.purchaseLimits.min).max(maxAllowed).safeParse(quantity).success;
};
