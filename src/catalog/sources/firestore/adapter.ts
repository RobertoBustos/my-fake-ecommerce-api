import { FieldPath, type DocumentSnapshot } from "firebase-admin/firestore";
import db from "../../../config/firestore.js";
import { getProductsByIds } from "../../../db/products.js";
import { runTransaction } from "../../../db/transactions.js";
import type { Product } from "../../../types/models.js";
import {
  OutOfStockError,
  type CatalogSource,
  type ChangedProducts,
  type Reservation,
  type SourceProduct,
} from "../../ports.js";

// Must match COLLECTION in db/products.ts.
const PRODUCTS_COLLECTION = "products";

const fromProduct = ({ id, stock, ...rest }: Product): SourceProduct => ({
  ...rest,
  localId: id,
  available: stock,
  updatedAt: null,
});

const fromDoc = (doc: DocumentSnapshot): SourceProduct =>
  fromProduct({ id: doc.id, ...doc.data() } as Product);

// Stock lives on the product document. Reservations don't expire yet and
// their key isn't stored, so they are not idempotent: reserve takes the units
// out and release puts them back, exactly as addToCart and cancelOrder did
// before this adapter existed.
export const firestoreCatalogSource: CatalogSource = {
  key: "fs",
  capabilities: { reservations: true, changeFeed: false },

  // Products carry no updatedAt yet, so every call lists the whole catalog
  // in pages; incremental sync needs that field first.
  async listChanged(_since, { cursor, limit }): Promise<ChangedProducts> {
    let query = db.collection(PRODUCTS_COLLECTION).orderBy(FieldPath.documentId());
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.limit(limit + 1).get();
    const docs = snapshot.docs.slice(0, limit);
    return {
      items: docs.map(fromDoc),
      deletedIds: [],
      nextCursor: snapshot.docs.length > limit ? docs.at(-1)?.id : undefined,
    };
  },

  async getProducts(localIds) {
    const products = await getProductsByIds(localIds);
    return products.map(fromProduct);
  },

  async reserve(localId, quantity, key): Promise<Reservation> {
    const productRef = db.collection(PRODUCTS_COLLECTION).doc(localId);
    await runTransaction(async (tx) => {
      const productDoc = await tx.get(productRef);
      const stock: number = productDoc.exists ? productDoc.get("stock") : 0;
      if (stock < quantity) {
        throw new OutOfStockError(localId);
      }
      tx.update(productRef, { stock: stock - quantity });
    });
    return { reservationId: key, localId, quantity, expiresAt: null };
  },

  // The units already left the stock in reserve; nothing else to do here.
  async confirm() {},

  async release({ localId, quantity }) {
    const productRef = db.collection(PRODUCTS_COLLECTION).doc(localId);
    await runTransaction(async (tx) => {
      const productDoc = await tx.get(productRef);
      // A deleted product has no stock to put the units back into.
      if (!productDoc.exists) return;
      tx.update(productRef, { stock: productDoc.get("stock") + quantity });
    });
  },
};
