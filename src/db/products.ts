import type { DocumentSnapshot } from "firebase-admin/firestore";
import type { Product } from "../types/models.js";
import db from "../config/firestore.js";

// The products collection of the Firestore catalog source. Only its adapter
// (src/catalog/sources/firestore/) reads it; listing the catalog reads the
// catalog index instead (db/catalogIndex.ts).
const COLLECTION = "products";
const toProduct = (doc: DocumentSnapshot): Product => ({ id: doc.id, ...doc.data() }) as Product;

// A single Firestore call for N ids (vs. N getProducts calls), used by the
// product DataLoader to avoid the N+1 problem (H10).
export const getProductsByIds = async (ids: readonly string[]): Promise<Product[]> => {
  if (ids.length === 0) {
    return [];
  }
  const refs = ids.map((id) => db.collection(COLLECTION).doc(String(id)));
  const docs = await db.getAll(...refs);
  return docs.filter((doc) => doc.exists).map(toProduct);
};
