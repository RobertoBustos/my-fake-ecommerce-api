import { GraphQLError } from "graphql";
import {
  addToCart,
  cancelOrder,
  createOrder,
  createPayment,
  getCart,
  getIncompleteOrders,
  getOrderTotals,
  getOrders,
  getProducts,
  removeFromCart,
  searchPayment,
  searchPaymentMethod,
  updateOrder,
} from "../db/index.js";
import {
  addToCartValidator,
  cancelOrderValidator,
  createOrderPaymentValidator,
  createOrderValidator,
  removeFromCartValidator,
  updateOrderValidator,
} from "./validators/index.js";

const resolvers = {
  Query: {
    products: async (_, args) => {
      const products = getProducts(args.filter);
      return products;
    },
    carts: async (_, args) => {
      const cart = getCart(args.filter);
      return cart;
    },
    orders: async (_, args) => {
      const orders = getOrders(args.filter);
      return orders;
    },
    incompleteOrders: async () => {
      const incompleteOrders = getIncompleteOrders();
      return incompleteOrders;
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
      const product = getProducts({ field: "id", value: input.productId });
      if (!product || product.length === 0) {
        throw new GraphQLError("Product not found", {
          extensions: {
            code: "NOT_FOUND",
            invalidArgument: "productId",
          },
        });
      }
      const cartItem = addToCart(product[0], input);
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
      const cart = getCart({ field: "cartId", value: input.cartId });
      if (!cart || cart.length === 0) {
        throw new GraphQLError("Cart not found", {
          extensions: {
            code: "NOT_FOUND",
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
    updateOrder: async (_, { input }) => {
      const validation = updateOrderValidator(input);
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
      const order = getOrders({ field: "id", value: input.id });
      if (!order || order.length === 0) {
        throw new GraphQLError("Order not found", {
          extensions: {
            code: "NOT_FOUND",
            invalidArgument: "cartId",
          },
        });
      }
      const newOrder = updateOrder(input);
      if (!newOrder) {
        return {
          code: 200,
          success: false,
          message: "There was an error updating the order",
          data: null,
        };
      }
      return {
        code: 200,
        success: true,
        message: "Order updated",
        data: newOrder,
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
    createOrderPayment: async (_, { input }) => {
      const validation = createOrderPaymentValidator(input);
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
      const order = getOrders({ field: "id", value: input.orderId });
      if (!order || order.length === 0) {
        throw new GraphQLError("Order not found", {
          extensions: {
            code: "NOT_FOUND",
            invalidArgument: "orderId",
          },
        });
      }
      if (!order[0].customer || !order[0].customer === null) {
        throw new GraphQLError("Order has no customer information", {
          extensions: {
            code: "NOT_FOUND",
            invalidArgument: "order.customer",
          },
        });
      }
      const totals = getOrderTotals(order[0].cart);
      const payment = createPayment(
        order[0].id,
        totals.total,
        order[0].customer.id
      );
      return {
        code: 200,
        success: true,
        message: "Payment created",
        data: payment,
      };
    },
  },
  CartItem: {
    product: async (parent) => {
      const product = getProducts({ field: "id", value: parent.productId });
      return product[0];
    },
  },
  Order: {
    totals: async (parent) => {
      const totals = getOrderTotals(parent.cart);
      return totals;
    },
    details: async (parent) => {
      const cart = getCart({ field: "cartId", value: parent.cart });
      return cart;
    },
    payment: async (parent) => {
      const payment = await searchPayment(parent.id);
      return payment;
    },
  },
  Payment: {
    payment_method: async (parent) => {
      if (parent.payment_method === null) return;
      const paymentMethod = await searchPaymentMethod(parent.payment_method);
      return paymentMethod;
    },
  },
};

export default resolvers;
