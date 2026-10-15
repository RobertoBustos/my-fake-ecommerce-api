import db from "../config/firestore.js";
import { computeOrderTotals } from "../utils/orderTotals.js";
import { getCart } from "./cart.js";
import { cancelPayment, getCustomer } from "./payment.js";

const COLLECTION = "orders";
const toOrder = (doc) => ({ id: doc.id, ...doc.data() });

export const getOrders = async ({ id, cart, status, userId } = {}) => {
  if (id !== undefined) {
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) {
      return [];
    }
    const order = toOrder(doc);
    // H2: un usuario nunca ve una orden que no es suya, ni por id directo.
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
  // != null / == null (no !==/===) a propósito: GraphQL manda un campo
  // opcional omitido como undefined, no null (H6).
  if (input.customer != null) {
    updates.customer = await getCustomer(input.customer);
  }
  if (input.address != null) {
    updates.address = input.address;
  }
  const resultingCustomer = updates.customer ?? existingOrder.customer;
  const resultingAddress = updates.address ?? existingOrder.address;
  // El status ya no lo manda el cliente (H3): solo lo deriva el servidor al
  // completarse los datos de envío, nunca por un valor que llegue en input.
  if (resultingCustomer !== null && resultingAddress !== null) {
    updates.status = "PAYMENT_PENDING";
  }
  await docRef.update(updates);
  return { ...existingOrder, ...updates };
};

export const cancelOrder = async (input) => {
  const docRef = db.collection(COLLECTION).doc(input.id);
  const doc = await docRef.get();
  if (!doc.exists) {
    return false;
  }
  const order = toOrder(doc);
  await docRef.update({ status: "CANCELLED" });
  if (order.paymentId) {
    await cancelPayment(order.paymentId);
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
