import env from "#src/config/env";
import db from "#src/config/firestore";
import type { CartItem, Order } from "#src/types/models";
import { logger } from "#src/utils/logger";
import { getCart } from "./cart.ts";
import { cancelOrderOutcome, OrderAlreadyCompleteError } from "./orders.ts";

// The sweep never releases the units of a PAYMENT_PENDING order, because a
// payment may be on its way. Nothing else ends an order whose checkout was
// left halfway, so its units would stay held forever. This cancels it once
// every reservation of its items expired more than the grace period ago,
// long after any payment of it could still be on its way.
// cancelOrder asks Stripe first: a PaymentIntent that is processing or
// succeeded keeps the order, which waits for its webhook. Otherwise the
// order is cancelled, its units released and its PaymentIntent cancelled;
// a payment that still arrives is refused by the webhook and logged.
// onCancelled runs for each order this sweep cancelled (not one already
// cancelled, say by its user meanwhile); the job sends the push from it. It
// can't stop the sweep: a failure is logged and the next order goes on.

// Must match COLLECTION in db/orders.ts.
const ORDERS_COLLECTION = "orders";
const DEFAULT_GRACE_HOURS = 24;
const PAGE_SIZE = 100;

export const abandonedOrderGraceMs = (): number => {
  const hours = Number(env.ABANDONED_ORDER_GRACE_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_GRACE_HOURS) * 3_600_000;
};

// Orders don't store when they were created, so the reservations tell how
// long the order has been waiting. An order without any reservation (items
// added before reservations existed) can't be judged and is left alone.
const isAbandoned = (items: CartItem[], cutoff: Date) => {
  const reservations = items.flatMap((item) => item.reservations ?? []);
  return (
    reservations.length > 0 &&
    reservations.every((r) => r.expiresAt !== null && r.expiresAt.getTime() <= cutoff.getTime())
  );
};

export const cancelAbandonedOrders = async ({
  now = new Date(),
  onCancelled,
}: { now?: Date; onCancelled?: (order: Order) => Promise<void> } = {}) => {
  const cutoff = new Date(now.getTime() - abandonedOrderGraceMs());
  const counts = { cancelled: 0, keptPaid: 0 };
  let after: string | undefined;
  for (;;) {
    let query = db
      .collection(ORDERS_COLLECTION)
      .where("status", "==", "PAYMENT_PENDING")
      .orderBy("__name__")
      .limit(PAGE_SIZE);
    if (after) query = query.startAfter(after);
    const page = await query.get();
    for (const doc of page.docs) {
      const order = { id: doc.id, ...doc.data() } as Order;
      if (!isAbandoned(await getCart({ orderId: order.id }), cutoff)) continue;
      try {
        // Gone, or cancelled meanwhile: either way nothing is left to hold.
        const outcome = await cancelOrderOutcome({ id: order.id });
        if (outcome !== "notFound") {
          counts.cancelled += 1;
          logger.event("order.abandoned", { orderId: order.id, cartId: order.cart });
        }
        if (outcome === "cancelled" && onCancelled) {
          await onCancelled(order).catch((err: Error) =>
            logger.error("Abandoned order callback failed", { orderId: order.id, error: err.message })
          );
        }
      } catch (err) {
        if (!(err instanceof OrderAlreadyCompleteError)) throw err;
        // Charged, or being charged: its webhook completes it.
        counts.keptPaid += 1;
        logger.warn("Abandoned order kept: its payment went through", { orderId: order.id });
      }
    }
    if (page.size < PAGE_SIZE) break;
    after = page.docs[page.docs.length - 1].id;
  }
  return counts;
};
