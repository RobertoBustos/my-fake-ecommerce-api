import db from "../config/firestore.js";

const COLLECTION = "products";
const toProduct = (doc) => ({ id: doc.id, ...doc.data() });

export const getProducts = async ({ id, category } = {}) => {
  if (id !== undefined) {
    const doc = await db.collection(COLLECTION).doc(String(id)).get();
    return doc.exists ? [toProduct(doc)] : [];
  }
  let query = db.collection(COLLECTION);
  if (category !== undefined) {
    query = query.where("category", "==", category);
  }
  const snapshot = await query.get();
  return snapshot.docs.map(toProduct);
};
