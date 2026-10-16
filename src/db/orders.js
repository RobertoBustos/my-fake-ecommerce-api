import db from "../config/firestore.js";
import { computeOrderTotals } from "../utils/orderTotals.js";
import { getCart } from "./cart.js";
import { cancelPayment, getCustomer } from "./payment.js";

const COLLECTION = "orders";
// Must match the collections in db/cart.js and db/products.js: cancelling
// reads the order's cart items and products inside one transaction.
const CART_COLLECTION = "cartItems";
const PRODUCTS_COLLECTION = "products";
const toOrder = (doc) => ({ id: doc.id, ...doc.data() });

export const getOrders = async ({ id, cart, status, userId } = {}) => {
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
  let query = db.collection(COLLECTION);
  if (cart !== undefined) query = query.where("cart", "==", cart);
  if (status !== undefined) query = query.where("status", "==", status);
  if (userId !== undefined) query = query.where("userId", "==", userId);
  const snapshot = await query.get();
  return snapshot.docs.map(toOrder);
};

export const getOrderTotals = async (id) => {
  const cart = await getCart({ orderId: id });
  return computeOrderTotals(cart);
};

export const getIncompleteOrders = async ({ cart, userId } = {}) => {
  const orders = await getOrders({ cart, userId });
  return orders.filter(
    (order) => order.status !== "COMPLETE" && order.status !== "CANCELLED"
  );
};

export const createOrder = async (input, userId = null) => {
  const docRef = db.collection(COLLECTION).doc();
  const newOrder = {
    customer: null,
    address: null,
    paymentId: null,
    cart: input.cartId,
    status: "INCOMPLETE",
    userId,
  };
  await docRef.set(newOrder);
  return { id: docRef.id, ...newOrder };
};

export const updateOrder = async (input) => {
  const docRef = db.collection(COLLECTION).doc(input.id);
  const doc = await docRef.get();
  if (!doc.exists) {
    return undefined;
  }
  const existingOrder = toOrder(doc);
  const updates = {};
  // != null / == null (not !==/===) on purpose: GraphQL sends an omitted
  // optional field as undefined, not null (H6).
  if (input.customer != null) {
    updates.customer = await getCustomer(input.customer);
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
  await docRef.update(updates);
  return { ...existingOrder, ...updates };
};

export class OrderAlreadyCompleteError extends Error {
  constructor(orderId) {
    super(`Order ${orderId} is already paid and can't be cancelled`);
    this.name = "OrderAlreadyCompleteError";
    this.orderId = orderId;
  }
}

// Cancelling puts the order's units back in stock, in the same transaction
// as the status change so it happens exactly once: a second cancel finds the
// order already CANCELLED and changes nothing. A COMPLETE order was paid, so
// its stock is sold and it can't be cancelled here.
export const cancelOrder = async (input) => {
  const docRef = db.collection(COLLECTION).doc(input.id);
  const outcome = await db.runTransaction(async (tx) => {
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
    const quantities = new Map();
    for (const itemDoc of itemsSnapshot.docs) {
      const { productId, quantity } = itemDoc.data();
      const key = String(productId);
      quantities.set(key, (quantities.get(key) ?? 0) + quantity);
    }
    const productRefs = [...quantities.keys()].map((id) =>
      db.collection(PRODUCTS_COLLECTION).doc(id)
    );
    const productDocs = await Promise.all(productRefs.map((ref) => tx.get(ref)));

    // Every read above happens before any write, as Firestore requires.
    tx.update(docRef, { status: "CANCELLED" });
    productDocs.forEach((productDoc, i) => {
      if (!productDoc.exists) return;
      tx.update(productRefs[i], {
        stock: productDoc.data().stock + quantities.get(productRefs[i].id),
      });
    });
    return { found: true, order, changed: true };
  });

  if (!outcome.found) {
    return false;
  }
  // Stripe isn't part of the Firestore transaction, so it goes after commit.
  if (outcome.changed && outcome.order.paymentId) {
    await cancelPayment(outcome.order.paymentId);
  }
  return true;
};

export const setOrderPayment = async (orderId, paymentId) => {
  const docRef = db.collection(COLLECTION).doc(orderId);
  const doc = await docRef.get();
  if (!doc.exists) {
    return false;
  }
  await docRef.update({ paymentId });
  return true;
};

export const deleteOrder = async (id) => {
  await db.collection(COLLECTION).doc(id).delete();
};

export const markOrderComplete = async (id) => {
  const docRef = db.collection(COLLECTION).doc(id);
  const doc = await docRef.get();
  if (!doc.exists) {
    return false;
  }
  await docRef.update({ status: "COMPLETE" });
  return true;
};
