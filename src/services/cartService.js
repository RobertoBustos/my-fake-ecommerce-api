import { GraphQLError } from "graphql";
import {
  addToCart as addToCartDb,
  getProducts,
  removeFromCart as removeFromCartDb,
} from "../db/index.js";
import {
  addToCartValidator,
  removeFromCartValidator,
  validateCartQuantity,
} from "../schema/validators/index.js";

export const addToCart = async (input) => {
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
  const product = await getProducts({
    field: "id",
    value: input.productId,
  });
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
  const cartItem = await addToCartDb(product[0], input);
  return {
    code: 200,
    success: true,
    message: "Product added",
    data: cartItem,
  };
};

export const removeFromCart = async (input) => {
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
  const result = await removeFromCartDb(input);
  return {
    code: 200,
    success: result,
    message: result
      ? "Item Removed"
      : "There was an error removing the item",
  };
};
