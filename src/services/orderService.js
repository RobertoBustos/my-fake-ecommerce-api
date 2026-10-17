import { GraphQLError } from "graphql";
import {
  cancelOrder as cancelOrderDb,
  createOrder as createOrderDb,
  createPayment,
  getCart,
  getOrderTotals,
  getOrders,
  OrderAlreadyCompleteError,
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
import { withContentionRetryHint } from "./errors.js";

export const createOrder = async (input, userId) => {
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
  // Someone else's cart looks exactly like a missing one (H2).
  if (!cart || cart.length === 0 || cart.some((item) => item.userId !== userId)) {
    throw new GraphQLError("Cart not found", {
      extensions: {
        code: "NOT_FOUND",
        invalidArgument: "cartId",
      },
    });
  }
  const order = await createOrderDb(input, userId);
  await updateCartItems(input.cartId, order.id);
  return {
    code: 200,
    success: true,
    message: "Order created",
    data: order,
  };
};

export const updateOrder = async (input, userId) => {
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
  const order = await getOrders({ id: input.id, userId });
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

export const cancelOrder = async (input, userId) => {
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
  const order = await getOrders({ id: input.id, userId });
  if (order.length === 0) {
    throw new GraphQLError("Order not found", {
      extensions: {
        code: "NOT_FOUND",
        invalidArgument: "id",
      },
    });
  }
  let result;
  try {
    result = await withContentionRetryHint(() => cancelOrderDb(input));
  } catch (err) {
    if (err instanceof OrderAlreadyCompleteError) {
      throw new GraphQLError("A paid order can't be cancelled", {
        extensions: {
          code: "BAD_USER_INPUT",
          invalidArgument: "id",
        },
      });
    }
    throw err;
  }
  return {
    code: 200,
    success: result,
    message: result
      ? "Order cancelled"
      : "There was an error cancelling the order",
  };
};

export const createOrderPayment = async (input, userId) => {
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
  const order = await getOrders({ id: input.orderId, userId });
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
