import { FieldPath, type DocumentSnapshot, type Query } from "firebase-admin/firestore";
import type { Page, Product } from "../types/models.js";
import db from "../config/firestore.js";
import { paginateQuery } from "./pagination.js";

const COLLECTION = "products";
const toProduct = (doc: DocumentSnapshot): Product => ({ id: doc.id, ...doc.data() }) as Product;

export const getProducts = async ({
  id,
  category,
}: { id?: string; category?: string } = {}): Promise<Product[]> => {
  if (id !== undefined) {
    const doc = await db.collection(COLLECTION).doc(String(id)).get();
    return doc.exists ? [toProduct(doc)] : [];
  }
  let query: Query = db.collection(COLLECTION);
  if (category !== undefined) {
    query = query.where("category", "==", category);
  }
  const snapshot = await query.get();
  return snapshot.docs.map(toProduct);
};

// The products query: one page read from Firestore, not the whole catalog.
export const listProducts = async (
  { id, category }: { id?: string | null; category?: string | null } = {},
  page: Page = {}
) => {
  let query: Query = db.collection(COLLECTION);
  if (id !== undefined) query = query.where(FieldPath.documentId(), "==", String(id));
  if (category !== undefined) query = query.where("category", "==", category);
  return paginateQuery(query, page, toProduct);
};

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
