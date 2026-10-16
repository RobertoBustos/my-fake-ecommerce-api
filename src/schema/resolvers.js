import {
  getCart,
  getCartWithoutOrder,
  getIncompleteOrders,
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
    orders: async (_, { id, cart, status, first, after }, context) => {
      // H2: a user only sees their own orders, even when requesting a
      // direct id that isn't theirs.
      const orders = await getOrders({ id, cart, status, userId: context.user.uid });
      return paginate(orders, { first, after });
    },
    incompleteOrders: async (_, { cart, first, after }, context) => {
      const incompleteOrders = await getIncompleteOrders({ cart, userId: context.user.uid });
      return paginate(incompleteOrders, { first, after });
    },
  },

  Mutation: {
    addToCart: async (_, { input }) => cartService.addToCart(input),
    removeFromCart: async (_, { input }) => cartService.removeFromCart(input),
    createOrder: async (_, { input }, context) =>
      orderService.createOrder(input, context.user.uid),
    updateOrder: async (_, { input }) => orderService.updateOrder(input),
    cancelOrder: async (_, { input }) => orderService.cancelOrder(input),
    createOrderPayment: async (_, { input }) =>
      orderService.createOrderPayment(input),
  },
  CartItem: {
    product: async (parent, _args, context) => {
      return context.loaders.products.load(parent.productId);
    },
  },
  Order: {
    totals: async (parent, _args, context) => {
      return context.loaders.orderTotals.load(parent.id);
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
