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
import { paginate } from "../utils/pagination.js";

const resolvers = {
  Query: {
    products: async (_, { id, category, first, after }) => {
      const products = await getProducts({ id, category });
      return paginate(products, { first, after });
    },
    carts: async (_, { cartId, productId, first, after }) => {
      const cart = await getCartWithoutOrder({ cartId, productId });
      return paginate(cart, { first, after });
    },
    orders: async (_, { id, cart, status, first, after }) => {
      const orders = await getOrders({ id, cart, status });
      return paginate(orders, { first, after });
    },
    incompleteOrders: async (_, { cart, first, after }) => {
      const incompleteOrders = await getIncompleteOrders({ cart });
      return paginate(incompleteOrders, { first, after });
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
      const product = await getProducts({ id: parent.productId });
      return product[0];
    },
  },
  Order: {
    totals: async (parent) => {
      const totals = await getOrderTotals(parent.id);
      return totals;
    },
    details: async (parent) => {
      const cart = await getCart({ orderId: parent.id });
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
