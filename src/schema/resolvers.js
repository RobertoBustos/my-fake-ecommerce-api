import { GraphQLError } from "graphql";
import {
  addToCart,
  cancelOrder,
  getCart,
  getCartById,
  getOrderById,
  getOrders,
  getProductById,
  getProducts,
  removeFromCart,
} from "../db/index.js";
import {
  addToCartValidator,
  cancelOrderValidator,
  cartValidator,
  createOrderValidator,
  orderValidator,
  productValidator,
  removeFromCartValidator,
} from "./validators/index.js";

const resolvers = {
  Query: {
    products: async () => {
      const products = getProducts();
      return products;
    },
    product: async (_, args) => {
      const validation = productValidator(args);
      if (!validation) {
        throw new GraphQLError(
          "One or more parameters sent have an invalid value",
          {
            extensions: {
              code: "BAD_REQUEST",
            },
          }
        );
      }
      const product = getProductById(args.id);
      if (!product) {
        throw new GraphQLError("Product not found", {
          extensions: {
            code: "NOT_FOUND",
          },
        });
      }
      return product;
    },
    carts: async () => {
      const cart = getCart();
      return cart;
    },
    cart: async (_, args) => {
      const validation = cartValidator(args);
      if (!validation) {
        throw new GraphQLError(
          "One or more parameters sent have an invalid value",
          {
            extensions: {
              code: "BAD_REQUEST",
            },
          }
        );
      }
      const cart = getCartById(args.id);
      if (!cart) {
        throw new GraphQLError("Cart not found", {
          extensions: {
            code: "NOT_FOUND",
          },
        });
      }
      return cart;
    },
    orders: async () => {
      const orders = getOrders();
      return orders;
    },
    order: async (_, args) => {
      const validation = orderValidator(args);
      if (!validation) {
        throw new GraphQLError(
          "One or more parameters sent have an invalid value",
          {
            extensions: {
              code: "BAD_REQUEST",
            },
          }
        );
      }
      const order = getOrderById(args.id);
      if (!order) {
        throw new GraphQLError("Order not found", {
          extensions: {
            code: "NOT_FOUND",
          },
        });
      }
      return order;
    },
  },

  Mutation: {
    addToCart: async (_, { input }) => {
      const validation = addToCartValidator(input);
      if (!validation) {
        throw new GraphQLError(
          "One or more parameters sent have an invalid value",
          {
            extensions: {
              code: "BAD_REQUEST",
            },
          }
        );
      }
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
      const cartItem = addToCart(product, input);
      return {
        code: 200,
        success: true,
        message: "Product added",
        data: cartItem,
      };
    },
    removeFromCart: async (_, { input }) => {
      const validation = removeFromCartValidator(input);
      if (!validation) {
        throw new GraphQLError(
          "One or more parameters sent have an invalid value",
          {
            extensions: {
              code: "BAD_REQUEST",
            },
          }
        );
      }
      const result = removeFromCart(input);
      return {
        code: 200,
        success: result,
        message: result
          ? "Item Removed"
          : "There was an error removing the item",
      };
    },
    createOrder: async (_, { input }) => {
      const validation = createOrderValidator(input);
      if (!validation) {
        throw new GraphQLError(
          "One or more parameters sent have an invalid value",
          {
            extensions: {
              code: "BAD_REQUEST",
            },
          }
        );
      }
      const cart = getCartById(input.cartId);
      if (!cart || cart.length === 0) {
        throw new GraphQLError("Cart not found", {
          extensions: {
            code: "GRAPHQL_VALIDATION_FAILED",
            invalidArgument: "cartId",
          },
        });
      }
      const order = createOrder(input);
      return {
        code: 200,
        success: true,
        message: "Order created",
        data: order,
      };
    },
    cancelOrder: async (_, { input }) => {
      const validation = cancelOrderValidator(input);
      if (!validation) {
        throw new GraphQLError(
          "One or more parameters sent have an invalid value",
          {
            extensions: {
              code: "BAD_REQUEST",
            },
          }
        );
      }
      const result = cancelOrder(input);
      return {
        code: 200,
        success: result,
        message: result
          ? "Order cancelled"
          : "There was an error cancelling the order",
      };
    },
  },

  CartItem: {
    product: async (parent) => {
      const product = getProductById(parent.productId);
      return product;
    },
  },
  Order: {
    totals: async (parent) => {
      const cart = getCartById(parent.cart);
      const units = cart.reduce((acc, item) => (acc += item.quantity), 0);
      const subtotal = cart.reduce((acc, item) => (acc += item.subtotal), 0);
      const taxes = Math.floor(subtotal * 0.16);

      return {
        currency: "MXN",
        items: cart.length,
        units: units,
        subTotal: subtotal,
        taxes: taxes,
        discount: 0,
        total: subtotal + taxes,
      };
    },
    details: async (parent) => {
      const cart = getCartById(parent.cart);
      return cart;
    },
  },
};

export default resolvers;
