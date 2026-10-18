import { FieldPath, type DocumentSnapshot, type Query } from "firebase-admin/firestore";
import type { PriceQuote } from "../pricing/index.js";
import type {
  Address,
  CartItem,
  Order,
  OrderStatus,
  OrderTotals,
  Page,
} from "../types/models.js";
import db from "../config/firestore.js";
import { runTransaction } from "./transactions.js";
import { computeOrderTotals } from "../utils/orderTotals.js";
import { confirmTasks, getCart, releaseTasks } from "./cart.js";
import { isOrderOpen, OPEN_STATUSES } from "./orderStatus.js";
import { paginateQuery } from "./pagination.js";
import { cancelPayment, getCustomer, searchPayment, type CustomerDetails } from "./payment.js";
import { logger } from "../utils/logger.js";
import { runInventoryTasks } from "../catalog/inventoryQueue.js";
import { queueInventoryTasks } from "./inventoryTasks.js";

export { isOrderOpen };

const COLLECTION = "orders";
// Must match COLLECTION in db/cart.ts: cancelling reads the order's cart
// items inside its transaction.
const CART_COLLECTION = "cartItems";
const toOrder = (doc: DocumentSnapshot): Order => ({ id: doc.id, ...doc.data() }) as Order;

export class OrderClosedError extends Error {
  orderId: string;
  status: OrderStatus;
  constructor(orderId: string, status: OrderStatus) {
    super(`Order ${orderId} is ${status} and can't be changed`);
    this.name = "OrderClosedError";
    this.orderId = orderId;
    this.status = status;
  }
}

export class CartAlreadyOrderedError extends Error {
  cartId: string;
  constructor(cartId: string) {
    super(`Cart ${cartId} has no items left to order`);
    this.name = "CartAlreadyOrderedError";
    this.cartId = cartId;
  }
}

export class OrderAlreadyCompleteError extends Error {
  orderId: string;
  constructor(orderId: string) {
    super(`Order ${orderId} is already paid and can't be cancelled`);
    this.name = "OrderAlreadyCompleteError";
    this.orderId = orderId;
  }
}

interface OrderFilters {
  id?: string | null;
  cart?: string | null;
  status?: OrderStatus | null;
  userId?: string;
}

export const getOrders = async ({
  id,
  cart,
  status,
  userId,
}: Omit<OrderFilters, "id"> & { id?: string } = {}): Promise<Order[]> => {
  if (id !== undefined) {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) {
      return [];
    }
    const order = toOrder(doc);
    // H2: a user never sees an order that isn't theirs, not even by direct id.
    if (userId !== undefined && order.userId !== userId) {
      return [];
    }
    return [order];
  }
  let query: Query = db.collection(COLLECTION);
  if (cart !== undefined) query = query.where("cart", "==", cart);
  if (status !== undefined) query = query.where("status", "==", status);
  if (userId !== undefined) query = query.where("userId", "==", userId);
  const snapshot = await query.get();
  return snapshot.docs.map(toOrder);
};

export const getOrderTotals = async (id: string): Promise<OrderTotals> => {
  const cart = await getCart({ orderId: id });
  return computeOrderTotals(cart);
};

// The orders query, one page at a time. Filtering by userId in the query
// itself keeps H2: another user's order never appears, not even by direct id.
export const listOrders = async (
  { id, cart, status, userId }: OrderFilters = {},
  page: Page = {}
) => {
  let query: Query = db.collection(COLLECTION);
  if (id !== undefined) query = query.where(FieldPath.documentId(), "==", id);
  if (cart !== undefined) query = query.where("cart", "==", cart);
  if (status !== undefined) query = query.where("status", "==", status);
  if (userId !== undefined) query = query.where("userId", "==", userId);
  return paginateQuery(query, page, toOrder);
};

// Open orders filtered by status in Firestore instead of in memory.
export const listIncompleteOrders = async (
  { cart, userId }: Pick<OrderFilters, "cart" | "userId"> = {},
  page: Page = {}
) => {
  let query: Query = db.collection(COLLECTION).where("status", "in", OPEN_STATUSES);
  if (cart !== undefined) query = query.where("cart", "==", cart);
  if (userId !== undefined) query = query.where("userId", "==", userId);
  return paginateQuery(query, page, toOrder);
};

// Creating the order and claiming the cart's free items happen in one
// transaction: two concurrent createOrder calls for the same cart can't both
// succeed, and a cart whose items are all ordered can't produce an empty order.
export const createOrder = async (
  input: { cartId: string },
  userId: string | null = null
): Promise<Order> => {
  return runTransaction(async (tx) => {
    const items = await tx.get(
      db
        .collection(CART_COLLECTION)
        .where("cartId", "==", input.cartId)
        .where("orderId", "==", null)
    );
    if (items.empty) {
      throw new CartAlreadyOrderedError(input.cartId);
    }
    const docRef = db.collection(COLLECTION).doc();
    const newOrder: Omit<Order, "id"> = {
      customer: null,
      address: null,
      paymentId: null,
      cart: input.cartId,
      status: "INCOMPLETE",
      userId,
    };
    tx.set(docRef, newOrder);
    items.docs.forEach((itemDoc) => tx.update(itemDoc.ref, { orderId: docRef.id }));
    return { id: docRef.id, ...newOrder };
  });
};

export interface UpdateOrderInput {
  id: string;
  customer?: CustomerDetails | null;
  address?: Address | null;
}

export const updateOrder = async (
  input: UpdateOrderInput,
  userId: string
): Promise<Order | undefined> => {
  const docRef = db.collection(COLLECTION).doc(input.id);
  // Stripe isn't part of the transaction (a retry would call it again), so
  // the customer is resolved first. It only ever touches this user's own
  // customer, so doing it for an order that turns out to be closed is harmless.
  const customer =
    // != null (not !==): GraphQL sends an omitted optional field as
    // undefined, not null (H6).
    input.customer != null ? await getCustomer(input.customer, userId) : undefined;

  return runTransaction(async (tx) => {
    const doc = await tx.get(docRef);
    if (!doc.exists) {
      return undefined;
    }
    const existingOrder = toOrder(doc);
    if (!isOrderOpen(existingOrder)) {
      throw new OrderClosedError(existingOrder.id, existingOrder.status);
    }
    const updates: Partial<Order> = {};
    if (customer !== undefined) {
      updates.customer = customer;
    }
    if (input.address != null) {
      updates.address = input.address;
    }
    const resultingCustomer = updates.customer ?? existingOrder.customer;
    const resultingAddress = updates.address ?? existingOrder.address;
    // The client no longer sends status (H3): the server only derives it once
    // shipping data is complete, never from a value that arrives in input.
    if (resultingCustomer !== null && resultingAddress !== null) {
      updates.status = "PAYMENT_PENDING";
    }
    tx.update(docRef, updates);
    return { ...existingOrder, ...updates };
  });
};

// A PaymentIntent in these states has been (or is being) charged; cancelling
// the order would hand back stock that was paid for.
const CHARGED_PAYMENT_STATUSES = new Set(["processing", "succeeded"]);

// Cancelling queues the release of the order's units in the same
// transaction as the status change, so it happens exactly once: a second
// cancel finds the order already CANCELLED and changes nothing. A COMPLETE order was paid, so its
// stock is sold and it can't be cancelled here.
export const cancelOrder = async (input: { id: string }): Promise<boolean> => {
  const docRef = db.collection(COLLECTION).doc(input.id);

  // A payment that went through before its webhook arrived still counts as paid.
  const current = (await docRef.get()).data() as Order | undefined;
  if (current?.paymentId && isOrderOpen(current)) {
    const payment = await searchPayment("id", current.paymentId);
    if (payment && CHARGED_PAYMENT_STATUSES.has(payment.status)) {
      throw new OrderAlreadyCompleteError(input.id);
    }
  }

  type Outcome =
    | { found: false }
    | { found: true; order: Order; changed: false }
    | { found: true; order: Order; changed: true; taskIds: string[] };
  const outcome = await runTransaction(async (tx): Promise<Outcome> => {
    const doc = await tx.get(docRef);
    if (!doc.exists) {
      return { found: false };
    }
    const order = toOrder(doc);
    if (order.status === "COMPLETE") {
      throw new OrderAlreadyCompleteError(order.id);
    }
    if (order.status === "CANCELLED") {
      return { found: true, order, changed: false };
    }

    const itemsSnapshot = await tx.get(
      db.collection(CART_COLLECTION).where("orderId", "==", order.id)
    );
    const items = itemsSnapshot.docs.map((itemDoc) => ({ id: itemDoc.id, ...itemDoc.data() }) as CartItem);
    const taskIds = await queueInventoryTasks(
      tx,
      items.flatMap((item) => releaseTasks(item, "cancelOrder", order.id))
    );
    tx.update(docRef, { status: "CANCELLED" });
    return { found: true, order, changed: true, taskIds };
  });

  if (!outcome.found) {
    return false;
  }
  // Run right away; what the source refuses now stays queued for the job.
  if (outcome.changed) {
    await runInventoryTasks(outcome.taskIds);
  }
  // Stripe isn't part of the Firestore transaction, so it goes after commit.
  // The order is already cancelled; if Stripe fails here, a later payment on
  // this order is caught by the webhook, which refuses to complete it.
  if (outcome.changed && outcome.order.paymentId) {
    await cancelPayment(outcome.order.paymentId).catch((err) => {
      logger.error("Could not cancel the PaymentIntent of a cancelled order", {
        orderId: outcome.order.id,
        paymentId: outcome.order.paymentId,
        error: (err as Error).message,
      });
    });
  }
  return true;
};

// The price each item of an order is paid at, by cart item id.
export type ItemPrices = Map<string, PriceQuote>;

// Moves an order's items to the prices their sources quote now, so the next
// createOrderPayment charges them. Inside a transaction with the order, so
// an order that stopped being payable in the meantime isn't touched.
export const repriceOrderItems = async (orderId: string, prices: ItemPrices): Promise<void> => {
  const docRef = db.collection(COLLECTION).doc(orderId);
  await runTransaction(async (tx) => {
    const doc = await tx.get(docRef);
    const order = doc.exists ? toOrder(doc) : null;
    if (!order || order.status !== "PAYMENT_PENDING") {
      throw new OrderClosedError(orderId, order?.status ?? "CANCELLED");
    }
    const items = await tx.get(db.collection(CART_COLLECTION).where("orderId", "==", orderId));
    for (const itemDoc of items.docs) {
      const quote = prices.get(itemDoc.id);
      if (quote === undefined) continue;
      const { quantity } = itemDoc.data() as CartItem;
      tx.update(itemDoc.ref, { ...quote, subtotal: quote.unitPrice * quantity });
    }
  });
};

export const setOrderPayment = async (orderId: string, paymentId: string): Promise<boolean> => {
  const docRef = db.collection(COLLECTION).doc(orderId);
  const doc = await docRef.get();
  if (!doc.exists) {
    return false;
  }
  await docRef.update({ paymentId });
  return true;
};

export const deleteOrder = async (id: string): Promise<void> => {
  await db.collection(COLLECTION).doc(id).delete();
};

// Called only by the Stripe webhook. The order is completed only if the
// event is for the order's own PaymentIntent and the amount Stripe charged
// is the order's current total; items added after the PaymentIntent was
// created would otherwise ship unpaid. Completing it queues the confirm of
// every reservation in the same transaction; they run after the commit and,
// if a source is down, from the inventory job. Returns { completed, reason }.
export const markOrderComplete = async (
  id: string,
  { paymentIntentId, amountReceived }: { paymentIntentId?: string; amountReceived?: number } = {}
): Promise<{ completed: boolean; reason?: string }> => {
  const docRef = db.collection(COLLECTION).doc(id);
  const result = await runTransaction(
    async (tx): Promise<{ completed: boolean; reason?: string; taskIds?: string[] }> => {
      const doc = await tx.get(docRef);
      if (!doc.exists) {
        return { completed: false, reason: "order not found" };
      }
      const order = toOrder(doc);
      if (order.status === "COMPLETE") {
        return { completed: true, reason: "already complete" };
      }
      const items = await tx.get(db.collection(CART_COLLECTION).where("orderId", "==", id));
      const cartItems = items.docs.map(
        (itemDoc) => ({ id: itemDoc.id, ...itemDoc.data() }) as CartItem
      );
      const { total } = computeOrderTotals(cartItems);

      if (order.status !== "PAYMENT_PENDING") {
        return { completed: false, reason: `order is ${order.status}` };
      }
      if (order.paymentId !== paymentIntentId) {
        return { completed: false, reason: "payment intent doesn't belong to the order" };
      }
      if (amountReceived !== total) {
        return {
          completed: false,
          reason: `amount received (${amountReceived}) doesn't match the order total (${total})`,
        };
      }
      const taskIds = await queueInventoryTasks(
        tx,
        cartItems.flatMap((item) => confirmTasks(item, id))
      );
      tx.update(docRef, { status: "COMPLETE" });
      return { completed: true, taskIds };
    }
  );
  // A confirm that fails never undoes the order: the money was charged.
  if (result.taskIds) {
    await runInventoryTasks(result.taskIds);
  }
  return { completed: result.completed, ...(result.reason ? { reason: result.reason } : {}) };
};
