import * as cartService from "../../services/cartService.js";
import * as orderService from "../../services/orderService.js";

// Mutations only delegate to services/, which own validation and business
// rules. ESLint rejects any db/ import in this file.
export const Mutation = {
  addToCart: async (_, { input }) => cartService.addToCart(input),
  removeFromCart: async (_, { input }) => cartService.removeFromCart(input),
  createOrder: async (_, { input }, context) =>
    orderService.createOrder(input, context.user.uid),
  updateOrder: async (_, { input }) => orderService.updateOrder(input),
  cancelOrder: async (_, { input }) => orderService.cancelOrder(input),
  createOrderPayment: async (_, { input }) =>
    orderService.createOrderPayment(input),
};
