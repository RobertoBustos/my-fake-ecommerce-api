import { GraphQLError } from "graphql";
import {
  addToCart,
  cancelOrder,
  createOrder,
  createPayment,
  getCart,
  getCartWithoutOrder,
  getIncompleteOrders,
  getOrderTotals,
  getOrders,
  getProducts,
  removeFromCart,
  searchPayment,
  searchPaymentMethod,
  setOrderPayment,
  updateCartItems,
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
      const products = await getProducts(args.filter);
      return products;
    },
    carts: async (_, args) => {
      const cart = await getCartWithoutOrder(args.filter);
      return cart;
    },
    orders: async (_, args) => {
      const orders = await getOrders(args.filter);
      return orders;
    },
    incompleteOrders: async (_, args) => {
      const incompleteOrders = await getIncompleteOrders(args.filter);
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
      const cartItem = await addToCart(product[0], input);
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
      const result = await removeFromCart(input);
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
      const cart = await getCart({ field: "cartId", value: input.cartId });
      if (!cart || cart.length === 0) {
        throw new GraphQLError("Cart not found", {
          extensions: {
            code: "NOT_FOUND",
            invalidArgument: "cartId",
          },
        });
      }
      const order = await createOrder(input);
      await updateCartItems(input.cartId, order.id);
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
      const order = await getOrders({ field: "id", value: input.id });
      if (!order || order.length === 0) {
        throw new GraphQLError("Order not found", {
          extensions: {
            code: "NOT_FOUND",
            invalidArgument: "cartId",
          },
        });
      }
      const newOrder = await updateOrder(input);
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
      const result = await cancelOrder(input);
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
      const order = await getOrders({ field: "id", value: input.orderId });
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
      const totals = await getOrderTotals(order[0].id);
      const payment = await createPayment(
        order[0].id,
        totals.total,
        order[0].customer.id
      );
      await setOrderPayment(order[0].id, payment.paymentId);
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
      const product = await getProducts({
        field: "id",
        value: parent.productId,
      });
      return product[0];
    },
  },
  Order: {
    totals: async (parent) => {
      const totals = await getOrderTotals(parent.id);
      return totals;
    },
    details: async (parent) => {
      const cart = await getCart({ field: "orderId", value: parent.id });
      return cart;
    },
    payment: async (parent) => {
      if (parent.paymentId === null) return;
      const payment = await searchPayment("id", parent.paymentId);
      return payment;
    },
  },
  Payment: {
    paymentDetails: async (parent) => {
      if (parent.payment_method === null) return;
      const paymentMethod = await searchPaymentMethod(parent.payment_method);
      return paymentMethod;
    },
  },
};

export default resolvers;
