import {
  getCart,
  getCartWithoutOrder,
  getIncompleteOrders,
  getOrderTotals,
  getOrders,
  getProducts,
  searchPayment,
  searchPaymentMethod,
} from "../db/index.js";
import * as cartService from "../services/cartService.js";
import * as orderService from "../services/orderService.js";

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
    addToCart: async (_, { input }) => cartService.addToCart(input),
    removeFromCart: async (_, { input }) => cartService.removeFromCart(input),
    createOrder: async (_, { input }) => orderService.createOrder(input),
    updateOrder: async (_, { input }) => orderService.updateOrder(input),
    cancelOrder: async (_, { input }) => orderService.cancelOrder(input),
    createOrderPayment: async (_, { input }) =>
      orderService.createOrderPayment(input),
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
