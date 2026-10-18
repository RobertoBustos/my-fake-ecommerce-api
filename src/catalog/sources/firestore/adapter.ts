import { FieldPath, Timestamp, type DocumentSnapshot, type Query } from "firebase-admin/firestore";
import db from "../../../config/firestore.js";
import { getProductsByIds } from "../../../db/products.js";
import { readReservation, reservationRef, type ReservationDoc } from "../../../db/reservations.js";
import { runTransaction } from "../../../db/transactions.js";
import type { Product } from "../../../types/models.js";
import { reservationTtlMs } from "../../reservationTtl.js";
import {
  OutOfStockError,
  ReservationExpiredError,
  type CatalogSource,
  type ChangedProducts,
  type Reservation,
  type SourceProduct,
} from "../../ports.js";

const SOURCE_KEY = "fs";

// Must match COLLECTION in db/products.ts.
const PRODUCTS_COLLECTION = "products";

// updatedAt is set by the seed and by every stock change; products written
// before it existed don't have it.
type StoredProduct = Product & { updatedAt?: Timestamp | Date | null };

const toDate = (value: Timestamp | Date | null | undefined): Date | null =>
  value == null ? null : value instanceof Date ? value : value.toDate();

const fromProduct = ({ id, stock, updatedAt, ...rest }: StoredProduct): SourceProduct => ({
  ...rest,
  localId: id,
  available: stock,
  updatedAt: toDate(updatedAt),
});

const fromDoc = (doc: DocumentSnapshot): SourceProduct =>
  fromProduct({ id: doc.id, ...doc.data() } as StoredProduct);

// Stock lives on the product document; reservations live in the
// reservations collection, keyed by their idempotency key. Taking the units
// and writing the reservation happen in one transaction, so a repeated call
// with the same key, or two calls racing for the last units, can't take
// stock twice.
export const firestoreCatalogSource: CatalogSource = {
  key: SOURCE_KEY,
  displayName: "Main catalog",
  capabilities: { reservations: true, changeFeed: false },

  // Without since, the whole catalog by document id. With since, only the
  // products whose updatedAt is later, by updatedAt and then id; the cursor
  // carries both ("<millis>:<id>"). A product without updatedAt never shows
  // up as changed, so only the full pass (the reconciliation) sees it.
  // Deleted products leave no trace here: the reconciliation removes them.
  async listChanged(since, { cursor, limit }): Promise<ChangedProducts> {
    let query: Query;
    if (since === null) {
      query = db.collection(PRODUCTS_COLLECTION).orderBy(FieldPath.documentId());
      if (cursor) query = query.startAfter(cursor);
    } else {
      query = db
        .collection(PRODUCTS_COLLECTION)
        .where("updatedAt", ">", since)
        .orderBy("updatedAt")
        .orderBy(FieldPath.documentId());
      if (cursor) {
        const separator = cursor.indexOf(":");
        query = query.startAfter(
          Timestamp.fromMillis(Number(cursor.slice(0, separator))),
          cursor.slice(separator + 1)
        );
      }
    }
    const snapshot = await query.limit(limit + 1).get();
    const docs = snapshot.docs.slice(0, limit);
    const last = docs.at(-1);
    const cursorOf = (doc: DocumentSnapshot) =>
      since === null ? doc.id : `${(doc.get("updatedAt") as Timestamp).toMillis()}:${doc.id}`;
    return {
      items: docs.map(fromDoc),
      deletedIds: [],
      nextCursor: snapshot.docs.length > limit && last ? cursorOf(last) : undefined,
    };
  },

  async getProducts(localIds) {
    const products = await getProductsByIds(localIds);
    return products.map(fromProduct);
  },

  async reserve(localId, quantity, key): Promise<Reservation> {
    const productRef = db.collection(PRODUCTS_COLLECTION).doc(localId);
    return runTransaction(async (tx) => {
      const existing = await readReservation(tx, key);
      if (existing) {
        return { reservationId: key, localId: existing.localId, quantity: existing.quantity, expiresAt: existing.expiresAt };
      }
      const productDoc = await tx.get(productRef);
      const stock: number = productDoc.exists ? productDoc.get("stock") : 0;
      if (stock < quantity) {
        throw new OutOfStockError(localId);
      }
      const now = new Date();
      const expiresAt = new Date(now.getTime() + reservationTtlMs(SOURCE_KEY));
      tx.update(productRef, { stock: stock - quantity, updatedAt: now });
      tx.set(reservationRef(key), {
        sourceKey: SOURCE_KEY,
        localId,
        quantity,
        status: "HELD",
        expiresAt,
        updatedAt: now,
      } satisfies ReservationDoc);
      return { reservationId: key, localId, quantity, expiresAt };
    });
  },

  // The units already left the stock in reserve; confirming only marks them
  // sold, so a later release can't put them back. Late is fine: a held
  // reservation past its expiry still holds its units until it is released.
  async confirm({ reservationId }) {
    await runTransaction(async (tx) => {
      const existing = await readReservation(tx, reservationId);
      if (!existing || existing.status === "RELEASED") {
        throw new ReservationExpiredError(reservationId);
      }
      if (existing.status === "CONFIRMED") return;
      tx.update(reservationRef(reservationId), { status: "CONFIRMED", updatedAt: new Date() });
    });
  },

  // Puts held units back once. A reservation made before the reservations
  // collection existed has no document: its units are put back from the
  // reservation passed in, and a RELEASED marker keeps a repeat from doing
  // it again.
  async release({ reservationId, localId, quantity }) {
    const productRef = db.collection(PRODUCTS_COLLECTION).doc(localId);
    await runTransaction(async (tx) => {
      const existing = await readReservation(tx, reservationId);
      if (existing && existing.status !== "HELD") return;
      const productDoc = await tx.get(productRef);
      const units = existing?.quantity ?? quantity;
      // A deleted product has no stock to put the units back into.
      if (productDoc.exists) {
        tx.update(productRef, { stock: productDoc.get("stock") + units, updatedAt: new Date() });
      }
      tx.set(reservationRef(reservationId), {
        sourceKey: SOURCE_KEY,
        localId: existing?.localId ?? localId,
        quantity: units,
        status: "RELEASED",
        expiresAt: existing?.expiresAt ?? null,
        updatedAt: new Date(),
      } satisfies ReservationDoc);
    });
  },
};
