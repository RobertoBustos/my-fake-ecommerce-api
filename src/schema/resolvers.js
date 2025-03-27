import { GraphQLError } from "graphql";
import { v4 as uuidv4 } from "uuid";
import cart from "../data/cart.js";
import products from "../data/products.js";
import fakePromise from "../utils/fakePromise.js";

let cartItems = cart;

const resolvers = {
  Query: {
    products: async (_, __, contextValue) => {
      await fakePromise();
      return products;
    },
    product: async (_, args, contextValue) => {
      await fakePromise();
      const product = products.find((product) => {
        return product.id == args.id;
      });
      return product;
    },
    cartItems: async (_, __, contextValue) => {
      await fakePromise();
      return cartItems;
    },
  },

  Mutation: {
    addToCart: async (_, { input }, contextValue) => {
      console.log("input", input);
      if (
        input.cartId === "" ||
        input.productId === "" ||
        input.quantity === 0
      ) {
        throw new GraphQLError(
          "One or more parameter sent have an invalid value",
          {
            extensions: {
              code: "BAD_REQUEST",
            },
          }
        );
      }
      await fakePromise();
      const product = products.find(
        (product) => product.id === input.productId
      );
      if (!product) {
        throw new GraphQLError("Product not found", {
          extensions: {
            code: "GRAPHQL_VALIDATION_FAILED",
            invalidArgument: "productId",
          },
        });
      }
      const existingItem = cartItems.find(
        (item) => item.productId === input.productId
      );
      if (existingItem) {
        existingItem.quantity += input.quantity;
        existingItem.subtotal += product.unitPrice * input.quantity;
        return {
          code: 200,
          success: true,
          message: "Product added to cart",
          data: existingItem,
        };
      }
      const newItem = {
        id: uuidv4(),
        cartId: input.cartId,
        productId: input.productId,
        quantity: input.quantity,
        unitPrice: product.unitPrice,
        subtotal: product.unitPrice * input.quantity,
      };
      cartItems.push(newItem);
      return {
        code: 200,
        success: true,
        message: "Product added to cart",
        data: newItem,
      };
    },
    removeFromCart: async (_, args, contextValue) => {
      await fakePromise();
      const cartItem = cartItems.find((item) => item.id == args.id);
      if (!cartItem) {
        throw new GraphQLError("Product not found", {
          extensions: {
            code: "GRAPHQL_VALIDATION_FAILED",
            invalidArgument: "id",
          },
        });
      }
      cartItems = cartItems.filter((item) => item.id != args.id);
      return {
        code: 200,
        success: true,
        message: "Item Removed Successfully",
      };
    },
  },

  CartItem: {
    product: async (parent, args, contextValue, info) => {
      return products.find((product) => product.id === parent.productId);
    },
  },
};

export default resolvers;
