import * as cartService from "../../services/cartService.js";
import * as orderService from "../../services/orderService.js";

// Mutations only delegate to services/, which own validation and business
// rules. Each one passes the authenticated uid so the service can check
// ownership. ESLint rejects any db/ import in this file.
export const Mutation = {
  addToCart: async (_, { input }, context) =>
    cartService.addToCart(input, context.user.uid),
  removeFromCart: async (_, { input }, context) =>
    cartService.removeFromCart(input, context.user.uid),
  createOrder: async (_, { input }, context) =>
    orderService.createOrder(input, context.user.uid),
  updateOrder: async (_, { input }, context) =>
    orderService.updateOrder(input, context.user.uid),
  cancelOrder: async (_, { input }, context) =>
    orderService.cancelOrder(input, context.user.uid),
  createOrderPayment: async (_, { input }, context) =>
    orderService.createOrderPayment(input, context.user.uid),
};
