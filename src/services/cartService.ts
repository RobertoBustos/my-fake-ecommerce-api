import { GraphQLError } from "graphql";
import {
  addToCart as addToCartDb,
  CartNotOwnedError,
  getOrders,
  getProducts,
  InsufficientStockError,
  isOrderOpen,
  OrderItemLockedError,
  removeFromCart as removeFromCartDb,
} from "../db/index.js";
import {
  checkAddToCart,
  checkRemoveFromCart,
  validateCartQuantity,
} from "../schema/validators/index.js";
import type { AddToCart, RemoveFromCart } from "../generated/graphql.js";
import type { CartItem, MutationAck, MutationResult } from "../types/models.js";
import { assertValidInput, withContentionRetryHint } from "./errors.js";

// Every write takes the authenticated user's uid and only touches what that
// user owns; anything else answers NOT_FOUND, as if it didn't exist (H2).
export const addToCart = async (
  input: AddToCart,
  userId: string
): Promise<MutationResult<CartItem>> => {
  assertValidInput(checkAddToCart, input);
  const product = await getProducts({ id: input.productId });
  if (!product || product.length === 0) {
    throw new GraphQLError("Product not found", {
      extensions: {
        code: "NOT_FOUND",
        invalidArgument: "productId",
      },
    });
  }
  if (!validateCartQuantity(input.quantity, product[0])) {
    throw new GraphQLError(
      `quantity must be between ${product[0].purchaseLimits.min} and ${Math.min(
        product[0].purchaseLimits.max,
        product[0].stock
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
  let cartItem: CartItem;
  try {
    cartItem = await withContentionRetryHint(() => addToCartDb(product[0], input, userId));
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
  let removed: boolean;
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
  return {
    code: "200",
    success: true,
    message: "Item Removed",
  };
};
