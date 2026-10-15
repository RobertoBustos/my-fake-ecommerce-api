import { GraphQLError } from "graphql";
import {
  cancelOrder as cancelOrderDb,
  createOrder as createOrderDb,
  createPayment,
  getCart,
  getOrderTotals,
  getOrders,
  setOrderPayment,
  updateCartItems,
  updateOrder as updateOrderDb,
} from "../db/index.js";
import {
  cancelOrderValidator,
  createOrderPaymentValidator,
  createOrderValidator,
  updateOrderValidator,
} from "../schema/validators/index.js";

export const createOrder = async (input) => {
  if (!createOrderValidator(input)) {
    throw new GraphQLError(
      "One or more parameters sent have an invalid value",
      {
        extensions: {
          code: "BAD_REQUEST",
        },
      }
    );
  }
  const cart = await getCart({ cartId: input.cartId });
  if (!cart || cart.length === 0) {
    throw new GraphQLError("Cart not found", {
      extensions: {
        code: "NOT_FOUND",
        invalidArgument: "cartId",
      },
    });
  }
  const order = await createOrderDb(input);
  await updateCartItems(input.cartId, order.id);
  return {
    code: 200,
    success: true,
    message: "Order created",
    data: order,
  };
};

export const updateOrder = async (input) => {
  if (!updateOrderValidator(input)) {
    throw new GraphQLError(
      "One or more parameters sent have an invalid value",
      {
        extensions: {
          code: "BAD_REQUEST",
        },
      }
    );
  }
  const order = await getOrders({ id: input.id });
  if (!order || order.length === 0) {
    throw new GraphQLError("Order not found", {
      extensions: {
        code: "NOT_FOUND",
        invalidArgument: "id",
      },
    });
  }
  const newOrder = await updateOrderDb(input);
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
};

export const cancelOrder = async (input) => {
  if (!cancelOrderValidator(input)) {
    throw new GraphQLError(
      "One or more parameters sent have an invalid value",
      {
        extensions: {
          code: "BAD_REQUEST",
        },
      }
    );
  }
  const result = await cancelOrderDb(input);
  return {
    code: 200,
    success: result,
    message: result
      ? "Order cancelled"
      : "There was an error cancelling the order",
  };
};

export const createOrderPayment = async (input) => {
  if (!createOrderPaymentValidator(input)) {
    throw new GraphQLError(
      "One or more parameters sent have an invalid value",
      {
        extensions: {
          code: "BAD_REQUEST",
        },
      }
    );
  }
  const order = await getOrders({ id: input.orderId });
  if (!order || order.length === 0) {
    throw new GraphQLError("Order not found", {
      extensions: {
        code: "NOT_FOUND",
        invalidArgument: "orderId",
      },
    });
  }
  if (!order[0].customer) {
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
};
