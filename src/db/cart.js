import db from "../config/firestore.js";

const COLLECTION = "cartItems";
const toCartItem = (doc) => ({ id: doc.id, ...doc.data() });

export const getCart = async ({ cartId, orderId, productId } = {}) => {
  let query = db.collection(COLLECTION);
  if (cartId !== undefined) query = query.where("cartId", "==", cartId);
  if (orderId !== undefined) query = query.where("orderId", "==", orderId);
  if (productId !== undefined) query = query.where("productId", "==", productId);
  const snapshot = await query.get();
  return snapshot.docs.map(toCartItem);
};

export const getCartWithoutOrder = async ({ cartId, productId } = {}) => {
  let query = db.collection(COLLECTION).where("orderId", "==", null);
  if (cartId !== undefined) query = query.where("cartId", "==", cartId);
  if (productId !== undefined) query = query.where("productId", "==", productId);
  const snapshot = await query.get();
  return snapshot.docs.map(toCartItem);
};

export const addToCart = async (product, input) => {
  const existingSnapshot = await db
    .collection(COLLECTION)
    .where("cartId", "==", input.cartId)
    .where("productId", "==", input.productId)
    .where("orderId", "==", input.orderId ?? null)
    .get();

  if (!existingSnapshot.empty) {
    const existingDoc = existingSnapshot.docs[0];
    const existingItem = toCartItem(existingDoc);
    const updates = {
      quantity: existingItem.quantity + input.quantity,
      subtotal: existingItem.subtotal + product.unitPrice * input.quantity,
    };
    await existingDoc.ref.update(updates);
    return { ...existingItem, ...updates };
  }

  const docRef = db.collection(COLLECTION).doc();
  const newItem = {
    cartId: input.cartId,
    orderId: null,
    productId: input.productId,
    quantity: input.quantity,
    unitPrice: product.unitPrice,
    subtotal: product.unitPrice * input.quantity,
  };
  await docRef.set(newItem);
  return { id: docRef.id, ...newItem };
};

export const removeFromCart = async (input) => {
  const docRef = db.collection(COLLECTION).doc(input.id);
  const doc = await docRef.get();
  if (!doc.exists) {
    return false;
  }
  await docRef.delete();
  return true;
};

export const updateCartItems = async (cartId, orderId) => {
  const snapshot = await db
    .collection(COLLECTION)
    .where("cartId", "==", cartId)
    .where("orderId", "==", null)
    .get();
  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.update(doc.ref, { orderId }));
  await batch.commit();
  return true;
};
