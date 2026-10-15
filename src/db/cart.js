import db from "../config/firestore.js";

const COLLECTION = "cartItems";
// Debe coincidir con COLLECTION en db/products.js: la transacción de stock
// necesita el doc del producto, no puede pasar por getProducts().
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

    // Todas las lecturas de una transacción de Firestore van antes que
    // cualquier escritura: primero el stock actual, luego el cart item.
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
