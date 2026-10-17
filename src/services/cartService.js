import { GraphQLError } from "graphql";
import {
  addToCart as addToCartDb,
  CartNotOwnedError,
  getOrders,
  getProducts,
  InsufficientStockError,
  removeFromCart as removeFromCartDb,
} from "../db/index.js";
import {
  addToCartValidator,
  removeFromCartValidator,
  validateCartQuantity,
} from "../schema/validators/index.js";
import { withContentionRetryHint } from "./errors.js";

// Every write takes the authenticated user's uid and only touches what that
// user owns; anything else answers NOT_FOUND, as if it didn't exist (H2).
export const addToCart = async (input, userId) => {
  if (!addToCartValidator(input)) {
    throw new GraphQLError(
      "One or more parameters sent have an invalid value",
      {
        extensions: {
          code: "BAD_USER_INPUT",
        },
      }
    );
  }
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
  }
  let cartItem;
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
    code: 200,
    success: true,
    message: "Product added",
    data: cartItem,
  };
};

export const removeFromCart = async (input, userId) => {
  if (!removeFromCartValidator(input)) {
    throw new GraphQLError(
      "One or more parameters sent have an invalid value",
      {
        extensions: {
          code: "BAD_REQUEST",
        },
      }
    );
  }
  const removed = await withContentionRetryHint(() => removeFromCartDb(input, userId));
  if (!removed) {
    throw new GraphQLError("Cart item not found", {
      extensions: {
        code: "NOT_FOUND",
        invalidArgument: "id",
      },
    });
  }
  return {
    code: 200,
    success: true,
    message: "Item Removed",
  };
};
