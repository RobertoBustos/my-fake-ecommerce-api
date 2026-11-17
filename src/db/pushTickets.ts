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
