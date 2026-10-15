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

// Una sola llamada a Firestore para N ids (vs. N llamadas de getProducts), la
// usa el DataLoader de productos para evitar el problema N+1 (H10).
export const getProductsByIds = async (ids) => {
  if (ids.length === 0) {
    return [];
  }
  const refs = ids.map((id) => db.collection(COLLECTION).doc(String(id)));
  const docs = await db.getAll(...refs);
  return docs.filter((doc) => doc.exists).map(toProduct);
};
