import { GraphQLError } from "graphql";
import { canonicalProductId, getCatalogProducts } from "../catalog/index.js";
import {
  cancelOrder as cancelOrderDb,
  CartAlreadyOrderedError,
  createOrder as createOrderDb,
  createPayment,
  getCart,
  getOrderTotals,
  getOrders,
  OrderAlreadyCompleteError,
  OrderClosedError,
  repriceOrderItems,
  setOrderPayment,
  updateOrder as updateOrderDb,
} from "../db/index.js";
import {
  checkCancelOrder,
  checkCreateOrder,
  checkCreateOrderPayment,
  checkUpdateOrder,
} from "../schema/validators/index.js";
import type { PaymentCreated } from "../db/payment.js";
import type {
  CancelOrder,
  CreateOrder,
  CreateOrderPayment,
  UpdateOrder,
} from "../generated/graphql.js";
import type { MutationAck, MutationResult, Order, Product } from "../types/models.js";
import { LEGACY_CURRENCY } from "../pricing/index.js";
import {
  assertValidInput,
  quoteOrConflict,
  withContentionRetryHint,
  withSourceRetryHint,
} from "./errors.js";

export const createOrder = async (
  input: CreateOrder,
  userId: string
): Promise<MutationResult<Order>> => {
  assertValidInput(checkCreateOrder, input);
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
  let order: Order;
  try {
    order = await withContentionRetryHint(() => createOrderDb(input, userId));
  } catch (err) {
    if (err instanceof CartAlreadyOrderedError) {
      throw new GraphQLError("This cart has already been ordered", {
        extensions: {
          code: "BAD_USER_INPUT",
          invalidArgument: "cartId",
        },
      });
    }
    throw err;
  }
  return {
    code: "200",
    success: true,
    message: "Order created",
    data: order,
  };
};

export const updateOrder = async (
  input: UpdateOrder,
  userId: string
): Promise<MutationResult<Order | null>> => {
  assertValidInput(checkUpdateOrder, input);
  const order = await getOrders({ id: input.id, userId });
  if (!order || order.length === 0) {
    throw new GraphQLError("Order not found", {
      extensions: {
        code: "NOT_FOUND",
        invalidArgument: "id",
      },
    });
  }
  let newOrder: Order | undefined;
  try {
    newOrder = await withContentionRetryHint(() => updateOrderDb(input, userId));
  } catch (err) {
    if (err instanceof OrderClosedError) {
      throw new GraphQLError(`A ${err.status} order can't be updated`, {
        extensions: {
          code: "BAD_USER_INPUT",
          invalidArgument: "id",
        },
      });
    }
    throw err;
  }
  if (!newOrder) {
    return {
      code: "200",
      success: false,
      message: "There was an error updating the order",
      data: null,
    };
  }
  return {
    code: "200",
    success: true,
    message: "Order updated",
    data: newOrder,
  };
};

export const cancelOrder = async (input: CancelOrder, userId: string): Promise<MutationAck> => {
  assertValidInput(checkCancelOrder, input);
  const order = await getOrders({ id: input.id, userId });
  if (order.length === 0) {
    throw new GraphQLError("Order not found", {
      extensions: {
        code: "NOT_FOUND",
        invalidArgument: "id",
      },
    });
  }
  let result: boolean;
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
    code: "200",
    success: result,
    message: result
      ? "Order cancelled"
      : "There was an error cancelling the order",
  };
};

// The order is charged at the prices its sources quote now, converted with
// today's exchange rate to today's settlement currency, not at the ones
// copied when the items were added. A changed price (in the source, in the
// rate or in the settlement currency) is never charged silently: the items
// move to the new price, nothing is charged, and the client gets the new
// prices so it can show the new total and pay again.
const assertCurrentPrices = async (orderId: string): Promise<void> => {
  const items = await getCart({ orderId });

  // A reservation past its expiry may be released at any moment, so the
  // order isn't charged for units it might no longer hold. The app reserves
  // again by removing those items and adding them back.
  const now = Date.now();
  const expired = items.filter((item) =>
    (item.reservations ?? []).some((r) => r.expiresAt !== null && r.expiresAt.getTime() <= now)
  );
  if (expired.length > 0) {
    throw new GraphQLError("The stock reservation of some items expired; add them to the cart again", {
      extensions: {
        code: "BAD_USER_INPUT",
        invalidArgument: "orderId",
        expiredItemIds: expired.map((item) => item.id),
      },
    });
  }
  const products = await withSourceRetryHint(() => getCatalogProducts(items.map((item) => item.productId)));

  const unavailable = items.filter((_, i) => products[i] === null);
  if (unavailable.length > 0) {
    throw new GraphQLError("Some products in the order are no longer available", {
      extensions: {
        code: "BAD_USER_INPUT",
        invalidArgument: "orderId",
        unavailableProductIds: unavailable.map((item) => canonicalProductId(item.productId)),
      },
    });
  }

  const quotes = await Promise.all(products.map((product) => quoteOrConflict(product as Product)));
  const changes = items.flatMap((item, i) => {
    const quote = quotes[i];
    // subtotal too: an item added twice while the price changed holds a
    // subtotal that no longer matches unitPrice × quantity.
    const changed =
      item.unitPrice !== quote.unitPrice ||
      (item.currency ?? LEGACY_CURRENCY) !== quote.currency ||
      item.subtotal !== quote.unitPrice * item.quantity;
    return changed ? [{ item, quote }] : [];
  });
  if (changes.length === 0) {
    return;
  }

  try {
    await withContentionRetryHint(() =>
      repriceOrderItems(orderId, new Map(changes.map(({ item, quote }) => [item.id, quote])))
    );
  } catch (err) {
    if (err instanceof OrderClosedError) {
      throw new GraphQLError(`A ${err.status} order can't be paid`, {
        extensions: { code: "BAD_USER_INPUT", invalidArgument: "orderId" },
      });
    }
    throw err;
  }
  throw new GraphQLError(
    "Prices changed since the products were added; review the new total and pay again",
    {
      extensions: {
        code: "BAD_USER_INPUT",
        invalidArgument: "orderId",
        priceChanges: changes.map(({ item, quote }) => ({
          productId: canonicalProductId(item.productId),
          previousUnitPrice: item.unitPrice,
          previousCurrency: item.currency ?? LEGACY_CURRENCY,
          unitPrice: quote.unitPrice,
          currency: quote.currency,
        })),
      },
    }
  );
};

export const createOrderPayment = async (
  input: CreateOrderPayment,
  userId: string
): Promise<MutationResult<PaymentCreated | null>> => {
  assertValidInput(checkCreateOrderPayment, input);
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
  // Only an order with its details complete, and not yet paid or cancelled,
  // can be charged.
  if (order[0].status !== "PAYMENT_PENDING") {
    throw new GraphQLError(`A ${order[0].status} order can't be paid`, {
      extensions: {
        code: "BAD_USER_INPUT",
        invalidArgument: "orderId",
      },
    });
  }
  await assertCurrentPrices(order[0].id);
  const totals = await getOrderTotals(order[0].id);
  // Stripe rejects a zero amount, which used to surface as an internal error.
  if (totals.total <= 0) {
    throw new GraphQLError("The order has no items to pay for", {
      extensions: {
        code: "BAD_USER_INPUT",
        invalidArgument: "orderId",
      },
    });
  }
  const payment = await createPayment(
    order[0].id,
    totals.total,
    order[0].customer.id,
    totals.currency
  );
  await setOrderPayment(order[0].id, payment.paymentId);
  return {
    code: "200",
    success: true,
    message: "Payment created",
    data: payment,
  };
};
