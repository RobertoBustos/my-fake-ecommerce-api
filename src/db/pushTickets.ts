import { FieldPath, type Timestamp } from "firebase-admin/firestore";
import db from "#src/config/firestore";

// pushTickets/{Expo ticket id}: a notification Expo accepted, kept until the
// receipts job reads its receipt, which tells whether it reached the device
// (ready about 15 minutes after the send, gone after 24 hours). expiresAt is
// the collection's TTL field: a ticket the job never got to is deleted by
// Firestore on its own.
const COLLECTION = "pushTickets";
const TICKET_TTL_MS = 2 * 24 * 60 * 60 * 1000;

export interface PushTicket {
  token: string;
  uid: string;
  createdAt: Date;
  expiresAt: Date;
}

export const savePushTickets = async (
  tickets: { ticketId: string; token: string; uid: string }[],
  now = new Date()
): Promise<void> => {
  if (tickets.length === 0) return;
  const batch = db.batch();
  for (const { ticketId, token, uid } of tickets) {
    const ticket: PushTicket = { token, uid, createdAt: now, expiresAt: new Date(now.getTime() + TICKET_TTL_MS) };
    batch.set(db.collection(COLLECTION).doc(ticketId), ticket);
  }
  await batch.commit();
};

// A page of the tickets sent at or before cutoff, oldest first. after is
// the last ticket of the previous page: tickets whose receipt isn't ready
// stay in the collection, so the next page starts after them.
export const listPushTicketsSentBefore = async (
  cutoff: Date,
  { limit, after }: { limit: number; after?: { ticketId: string; createdAt: Date } }
): Promise<({ ticketId: string } & PushTicket)[]> => {
  let query = db
    .collection(COLLECTION)
    .where("createdAt", "<=", cutoff)
    .orderBy("createdAt")
    .orderBy(FieldPath.documentId())
    .limit(limit);
  if (after) query = query.startAfter(after.createdAt, after.ticketId);
  const snapshot = await query.get();
  return snapshot.docs.map((doc) => ({
    ticketId: doc.id,
    token: doc.get("token") as string,
    uid: doc.get("uid") as string,
    createdAt: (doc.get("createdAt") as Timestamp).toDate(),
    expiresAt: (doc.get("expiresAt") as Timestamp).toDate(),
  }));
};

export const deletePushTickets = async (ticketIds: string[]): Promise<void> => {
  if (ticketIds.length === 0) return;
  const batch = db.batch();
  for (const ticketId of ticketIds) batch.delete(db.collection(COLLECTION).doc(ticketId));
  await batch.commit();
};
