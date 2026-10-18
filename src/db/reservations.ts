import type { DocumentReference, Transaction } from "firebase-admin/firestore";
import db from "../config/firestore.js";

// reservations/{key}: units set aside for a cart item. The document id is
// the idempotency key of the reserve call, so repeating a call finds the
// reservation it already made instead of making another.
//   HELD      → units are out of the sellable stock, waiting for payment
//   CONFIRMED → paid; the units are sold
//   RELEASED  → given back (item removed, order cancelled, write failed)

const COLLECTION = "reservations";

export type ReservationStatus = "HELD" | "CONFIRMED" | "RELEASED";

export interface ReservationDoc {
  sourceKey: string;
  localId: string;
  quantity: number;
  status: ReservationStatus;
  // null for the released markers of reservations made before this
  // collection existed.
  expiresAt: Date | null;
  updatedAt: Date;
}

export const reservationRef = (id: string): DocumentReference =>
  db.collection(COLLECTION).doc(id);

const toDate = (value: unknown): Date | null => {
  if (value == null) return null;
  if (value instanceof Date) return value;
  return (value as { toDate(): Date }).toDate();
};

const fromSnapshot = (doc: { exists: boolean; data(): unknown }): ReservationDoc | null => {
  if (!doc.exists) return null;
  const data = doc.data() as ReservationDoc;
  return { ...data, expiresAt: toDate(data.expiresAt), updatedAt: toDate(data.updatedAt) as Date };
};

// Inside the caller's transaction, so the check and the write that follows
// it can't interleave with another call for the same key.
export const readReservation = async (tx: Transaction, id: string) =>
  fromSnapshot(await tx.get(reservationRef(id)));

export const getReservation = async (id: string) => fromSnapshot(await reservationRef(id).get());

// HELD reservations whose expiresAt has passed, oldest first, one page at a
// time (pass the last id seen as `after`). Needs the composite index on
// (status, expiresAt) in firestore.indexes.json.
export const listExpiredHeldReservations = async (
  now: Date,
  limit: number,
  after?: { id: string; expiresAt: Date }
) => {
  let query = db
    .collection(COLLECTION)
    .where("status", "==", "HELD")
    .where("expiresAt", "<=", now)
    .orderBy("expiresAt")
    .orderBy("__name__");
  if (after) query = query.startAfter(after.expiresAt, after.id);
  const snapshot = await query.limit(limit).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(fromSnapshot(doc) as ReservationDoc) }));
};
