import type { DocumentSnapshot, Transaction } from "firebase-admin/firestore";
import type { Reservation } from "../catalog/ports.js";
import db from "../config/firestore.js";

// inventoryTasks/{reservationId}-{action}: the outbox of the purchase saga.
// A confirm or release that a source must run is written here in the same
// transaction that changes the order or the cart item, so it can't be lost
// when the source is down; the inventory queue runs it afterwards, retrying
// with backoff.
//   PENDING → waiting to run (nextAttemptAt says when)
//   DONE    → the source applied it
//   FAILED  → out of retries, or an error retrying can't fix; needs a person

const COLLECTION = "inventoryTasks";

export type InventoryAction = "confirm" | "release";
export type InventoryTaskStatus = "PENDING" | "DONE" | "FAILED";

export interface InventoryTaskDraft {
  action: InventoryAction;
  sourceKey: string;
  reservation: Reservation;
  // Why it was queued (removeFromCart, cancelOrder, orderComplete...), for the logs.
  reason: string;
  orderId: string | null;
}

export interface InventoryTask extends InventoryTaskDraft {
  id: string;
  status: InventoryTaskStatus;
  attempts: number;
  // null once the task is DONE or FAILED.
  nextAttemptAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// One task per reservation and action: queuing the same release twice (a
// retried transaction, the sweep and a removal racing) finds the task
// already there.
export const inventoryTaskId = (action: InventoryAction, reservationId: string) =>
  `${reservationId}-${action}`;

export const inventoryTaskRef = (id: string) => db.collection(COLLECTION).doc(id);

const toDate = (value: unknown): Date | null =>
  value == null ? null : value instanceof Date ? value : (value as { toDate(): Date }).toDate();

const toTask = (doc: DocumentSnapshot): InventoryTask => {
  const data = doc.data() as InventoryTask;
  return {
    ...data,
    id: doc.id,
    reservation: { ...data.reservation, expiresAt: toDate(data.reservation.expiresAt) },
    nextAttemptAt: toDate(data.nextAttemptAt),
    createdAt: toDate(data.createdAt) as Date,
    updatedAt: toDate(data.updatedAt) as Date,
  };
};

// Inside the caller's transaction. It reads before it writes, so call it
// before the caller's own writes. Returns the ids of every task the drafts
// map to, new or already queued, for the caller to run after its commit.
export const queueInventoryTasks = async (
  tx: Transaction,
  drafts: InventoryTaskDraft[]
): Promise<string[]> => {
  if (drafts.length === 0) return [];
  const ids = drafts.map((draft) => inventoryTaskId(draft.action, draft.reservation.reservationId));
  const existing = await tx.getAll(...ids.map(inventoryTaskRef));
  const now = new Date();
  drafts.forEach((draft, i) => {
    if (existing[i].exists) return;
    tx.set(inventoryTaskRef(ids[i]), {
      ...draft,
      status: "PENDING",
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    } satisfies Omit<InventoryTask, "id">);
  });
  return [...new Set(ids)];
};

export const readInventoryTask = async (tx: Transaction, id: string) => {
  const doc = await tx.get(inventoryTaskRef(id));
  return doc.exists ? toTask(doc) : null;
};

export const getInventoryTask = async (id: string) => {
  const doc = await inventoryTaskRef(id).get();
  return doc.exists ? toTask(doc) : null;
};

// PENDING tasks whose time has come, oldest first. Needs the composite
// index on (status, nextAttemptAt) in firestore.indexes.json.
export const listDueInventoryTasks = async (now: Date, limit: number) => {
  const snapshot = await db
    .collection(COLLECTION)
    .where("status", "==", "PENDING")
    .where("nextAttemptAt", "<=", now)
    .orderBy("nextAttemptAt")
    .limit(limit)
    .get();
  return snapshot.docs.map(toTask);
};
