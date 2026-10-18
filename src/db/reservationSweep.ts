import db from "../config/firestore.js";
import type { OrderStatus } from "../types/models.js";
import { queueInventoryTasks } from "./inventoryTasks.js";
import { listExpiredHeldReservations } from "./reservations.js";
import { runTransaction } from "./transactions.js";

// Queues the release of reservations that expired in abandoned carts; the
// inventory job runs the queue right after the sweep.
// The item stays in its cart with the expired reservation, so paying for it
// is refused (expiredItemIds) until the app reserves again.
//
// Skipped, because a payment may be on its way and the webhook confirms
// the reservation even after it expires:
//   - items of a PAYMENT_PENDING order
//   - items of a COMPLETE order (their confirm is in the queue)
// Released: items without an order or in an INCOMPLETE or CANCELLED order,
// and reservations no cart item holds (addToCart failed after reserving).

// Must match the collections in db/cart.ts and db/orders.ts.
const CART_COLLECTION = "cartItems";
const ORDERS_COLLECTION = "orders";
const PAGE_SIZE = 100;
const PAYMENT_MAY_ARRIVE: OrderStatus[] = ["PAYMENT_PENDING", "COMPLETE"];

type Expired = Awaited<ReturnType<typeof listExpiredHeldReservations>>[number];

// The holder's order is read in the same transaction that queues the
// release, so an order can't move to PAYMENT_PENDING between the check and
// the queuing. Returns the queued task id, or null when the reservation is skipped.
const queueRelease = (reservation: Expired): Promise<string | null> =>
  runTransaction(async (tx) => {
    const holders = await tx.get(
      db.collection(CART_COLLECTION).where("reservationIds", "array-contains", reservation.id)
    );
    const orderIds = [
      ...new Set(
        holders.docs.map((doc) => doc.get("orderId") as string | null).filter((id) => id != null)
      ),
    ];
    const orders = orderIds.length
      ? await tx.getAll(...orderIds.map((id) => db.collection(ORDERS_COLLECTION).doc(id)))
      : [];
    if (orders.some((doc) => PAYMENT_MAY_ARRIVE.includes(doc.get("status")))) {
      return null;
    }
    const [id] = await queueInventoryTasks(tx, [
      {
        action: "release",
        sourceKey: reservation.sourceKey,
        reservation: {
          reservationId: reservation.id,
          localId: reservation.localId,
          quantity: reservation.quantity,
          expiresAt: reservation.expiresAt,
        },
        reason: "expired",
        orderId: orders[0]?.id ?? null,
      },
    ]);
    return id;
  });

export const sweepExpiredReservations = async ({ now = new Date() }: { now?: Date } = {}) => {
  const counts = { queued: 0, skipped: 0 };
  let after: { id: string; expiresAt: Date } | undefined;
  for (;;) {
    const page = await listExpiredHeldReservations(now, PAGE_SIZE, after);
    for (const reservation of page) {
      const taskId = await queueRelease(reservation);
      if (taskId === null) {
        counts.skipped += 1;
        continue;
      }
      counts.queued += 1;
    }
    if (page.length < PAGE_SIZE) break;
    const last = page[page.length - 1];
    after = { id: last.id, expiresAt: last.expiresAt as Date };
  }
  return counts;
};
