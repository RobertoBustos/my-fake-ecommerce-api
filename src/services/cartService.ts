import { GraphQLError } from "graphql";
import { getCatalogProduct } from "#src/catalog/index.js";
import { parseProductId } from "#src/catalog/productId.js";
import {
  addToCart as addToCartDb,
  CartNotOwnedError,
  getOrders,
  InsufficientStockError,
  isOrderOpen,
  OrderItemLockedError,
  removeFromCart as removeFromCartDb,
} from "#src/db/index.js";
import {
  checkAddToCart,
  checkRemoveFromCart,
  validateCartQuantity,
} from "#src/schema/validators/index.js";
import type { AddToCart, RemoveFromCart } from "#src/generated/graphql.js";
import type { CartItem, MutationAck, MutationResult } from "#src/types/models.js";
import { logger } from "#src/utils/logger.js";
import {
  assertValidInput,
  quoteOrConflict,
  withContentionRetryHint,
  withSourceRetryHint,
} from "./errors.js";

// Every write takes the authenticated user's uid and only touches what that
// user owns; anything else answers NOT_FOUND, as if it didn't exist (H2).
export const addToCart = async (
  input: AddToCart,
  userId: string
): Promise<MutationResult<CartItem>> => {
  assertValidInput(checkAddToCart, input);
  const product = await withSourceRetryHint(() => getCatalogProduct(input.productId));
  if (!product) {
    throw new GraphQLError("Product not found", {
      extensions: {
        code: "NOT_FOUND",
        invalidArgument: "productId",
      },
    });
  }
  if (!validateCartQuantity(input.quantity, product)) {
    throw new GraphQLError(
      `quantity must be between ${product.purchaseLimits.min} and ${Math.min(
        product.purchaseLimits.max,
        product.stock
      )}`,
      {
        extensions: {
          code: "BAD_USER_INPUT",
          invalidArgument: "quantity",
        },
      }
    );
  }
  if (input.orderId != null) {
    const order = await getOrders({ id: input.orderId, userId });
    if (order.length === 0) {
      throw new GraphQLError("Order not found", {
        extensions: {
          code: "NOT_FOUND",
          invalidArgument: "orderId",
        },
      });
    }
    // A paid or cancelled order's items are settled. If the order already
    // has a PaymentIntent, the client must call createOrderPayment again,
    // which updates its amount; the webhook refuses a payment for less.
    if (!isOrderOpen(order[0])) {
      throw new GraphQLError(`Items can't be added to a ${order[0].status} order`, {
        extensions: {
          code: "BAD_USER_INPUT",
          invalidArgument: "orderId",
        },
      });
    }
    if (order[0].cart !== input.cartId) {
      throw new GraphQLError("cartId doesn't match the order's cart", {
        extensions: {
          code: "BAD_USER_INPUT",
          invalidArgument: "cartId",
        },
      });
    }
  }
  // The item keeps the price in the settlement currency, converted now.
  const quote = await quoteOrConflict(product);
  let cartItem: CartItem;
  try {
    cartItem = await withSourceRetryHint(() =>
      withContentionRetryHint(() => addToCartDb(product, input, userId, quote))
    );
  } catch (err) {
    if (err instanceof CartNotOwnedError) {
      throw new GraphQLError("Cart not found", {
        extensions: {
          code: "NOT_FOUND",
          invalidArgument: "cartId",
        },
      });
    }
    if (err instanceof InsufficientStockError) {
      throw new GraphQLError("Not enough stock available for this quantity", {
        extensions: {
          code: "BAD_USER_INPUT",
          invalidArgument: "quantity",
        },
      });
    }
    throw err;
  }
  logger.event("cart.item_added", {
    cartId: cartItem.cartId,
    orderId: cartItem.orderId,
    source: parseProductId(cartItem.productId).sourceKey,
    // What this call added, not the item's new total.
    quantity: input.quantity,
    unitPrice: cartItem.unitPrice,
    currency: cartItem.currency,
  });
  return {
    code: "200",
    success: true,
    message: "Product added",
    data: cartItem,
  };
};

export const removeFromCart = async (
  input: RemoveFromCart,
  userId: string
): Promise<MutationAck> => {
  assertValidInput(checkRemoveFromCart, input);
  let removed: CartItem | null;
  try {
    removed = await withContentionRetryHint(() => removeFromCartDb(input, userId));
  } catch (err) {
    if (err instanceof OrderItemLockedError) {
      throw new GraphQLError(`Items can't be removed from a ${err.status} order`, {
        extensions: {
          code: "BAD_USER_INPUT",
          invalidArgument: "id",
        },
      });
    }
    throw err;
  }
  if (!removed) {
    throw new GraphQLError("Cart item not found", {
      extensions: {
        code: "NOT_FOUND",
        invalidArgument: "id",
      },
    });
  }
  logger.event("cart.item_removed", {
    cartId: removed.cartId,
    orderId: removed.orderId,
    source: parseProductId(removed.productId).sourceKey,
    quantity: removed.quantity,
  });
  return {
    code: "200",
    success: true,
    message: "Item Removed",
  };
};
