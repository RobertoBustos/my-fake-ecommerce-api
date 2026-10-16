import db from "../config/firestore.js";

const COLLECTION = "cartItems";
// Must match COLLECTION in db/products.js: the stock transaction needs the
// product doc directly, it can't go through getProducts().
const PRODUCTS_COLLECTION = "products";
const toCartItem = (doc) => ({ id: doc.id, ...doc.data() });

export class InsufficientStockError extends Error {
  constructor(productId) {
    super(`Not enough stock for product ${productId}`);
    this.name = "InsufficientStockError";
    this.productId = productId;
  }
}

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
  return db.runTransaction(async (tx) => {
    const productRef = db.collection(PRODUCTS_COLLECTION).doc(String(product.id));
    const existingQuery = db
      .collection(COLLECTION)
      .where("cartId", "==", input.cartId)
      .where("productId", "==", input.productId)
      .where("orderId", "==", input.orderId ?? null);

    // All reads in a Firestore transaction must happen before any write:
    // current stock first, then the cart item.
    const productDoc = await tx.get(productRef);
    const existingSnapshot = await tx.get(existingQuery);

    const currentStock = productDoc.exists ? productDoc.data().stock : 0;
    if (currentStock < input.quantity) {
      throw new InsufficientStockError(product.id);
    }
    tx.update(productRef, { stock: currentStock - input.quantity });

    if (!existingSnapshot.empty) {
      const existingDoc = existingSnapshot.docs[0];
      const existingItem = toCartItem(existingDoc);
      const updates = {
        quantity: existingItem.quantity + input.quantity,
        subtotal: existingItem.subtotal + product.unitPrice * input.quantity,
      };
      tx.update(existingDoc.ref, updates);
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
    tx.set(docRef, newItem);
    return { id: docRef.id, ...newItem };
  });
};

// addToCart took these units out of stock; removing the item puts them back
// in the same transaction, so a concurrent purchase can't see a stale value.
export const removeFromCart = async (input) => {
  return db.runTransaction(async (tx) => {
    const docRef = db.collection(COLLECTION).doc(input.id);
    const doc = await tx.get(docRef);
    if (!doc.exists) {
      return false;
    }
    const item = toCartItem(doc);
    const productRef = db.collection(PRODUCTS_COLLECTION).doc(String(item.productId));
    const productDoc = await tx.get(productRef);

    tx.delete(docRef);
    if (productDoc.exists) {
      tx.update(productRef, { stock: productDoc.data().stock + item.quantity });
    }
    return true;
  });
};

const FIRESTORE_IN_QUERY_LIMIT = 30;

// A single round of reads for N orderIds (vs. N queries), used by the
// totals DataLoader to avoid the N+1 problem (H10). Firestore limits "in"
// to 30 values, so this splits into chunks when needed.
export const getCartByOrderIds = async (orderIds) => {
  const uniqueIds = [...new Set(orderIds)];
  if (uniqueIds.length === 0) {
    return [];
  }
  const chunks = [];
  for (let i = 0; i < uniqueIds.length; i += FIRESTORE_IN_QUERY_LIMIT) {
    chunks.push(uniqueIds.slice(i, i + FIRESTORE_IN_QUERY_LIMIT));
  }
  const snapshots = await Promise.all(
    chunks.map((chunk) => db.collection(COLLECTION).where("orderId", "in", chunk).get())
  );
  return snapshots.flatMap((snapshot) => snapshot.docs.map(toCartItem));
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
