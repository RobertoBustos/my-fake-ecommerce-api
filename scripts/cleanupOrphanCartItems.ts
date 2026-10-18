import { fileURLToPath } from "url";
import type { Query } from "firebase-admin/firestore";
import { canonicalProductId, getCatalogSource } from "../src/catalog/index.js";
import { reservationsToRelease } from "../src/db/cart.js";
import db from "../src/config/firestore.js";
import type { CartItem, OrderStatus } from "../src/types/models.js";

// Cart items created before v1.2.0 have no userId, so since the ownership
// checks (H20) nobody can remove them, and the stock addToCart took for them
// stays held forever. This script finds them and, with --apply, deletes each
// one and puts its units back on the product.
//
// Released (deleted, stock returned):
//   - no userId and no order: an abandoned pre-v1.2.0 cart item
//   - no userId and an orderId whose order no longer exists
// Reported only, never touched:
//   - items of CANCELLED orders: since v1.2.0 cancelOrder already returned
//     their stock, and there is no field that tells an order cancelled
//     before v1.2.0 (stock never returned) from one cancelled after.
//   - items of COMPLETE, PAYMENT_PENDING or INCOMPLETE orders: sold, being
//     paid or still being edited by their owner.

const CART_COLLECTION = "cartItems";
const ORDERS_COLLECTION = "orders";

const hasOwner = (item: Pick<CartItem, "userId">) => item.userId != null;

// cartIds (up to 30) narrows the scan; the command line always scans everything.
export const findOrphanCartItems = async ({ cartIds }: { cartIds?: string[] } = {}) => {
  let query: Query = db.collection(CART_COLLECTION);
  if (cartIds) query = query.where("cartId", "in", cartIds);
  const snapshot = await query.get();
  const ownerless = snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }) as CartItem)
    .filter((item) => !hasOwner(item));

  const orderIds = [
    ...new Set(ownerless.map((item) => item.orderId).filter((id): id is string => Boolean(id))),
  ];
  const orderDocs = orderIds.length
    ? await db.getAll(...orderIds.map((id) => db.collection(ORDERS_COLLECTION).doc(id)))
    : [];
  const orderStatus = new Map<string, OrderStatus | null>(
    orderDocs.map((doc) => [doc.id, doc.exists ? doc.get("status") : null])
  );

  const toRelease: CartItem[] = [];
  const reportOnly: (CartItem & { orderStatus: OrderStatus | null | undefined })[] = [];
  for (const item of ownerless) {
    if (item.orderId == null || orderStatus.get(item.orderId) === null) {
      toRelease.push(item);
    } else {
      reportOnly.push({ ...item, orderStatus: orderStatus.get(item.orderId) });
    }
  }

  const unitsByProduct: Record<string, number> = {};
  for (const item of toRelease) {
    const key = canonicalProductId(String(item.productId));
    unitsByProduct[key] = (unitsByProduct[key] ?? 0) + item.quantity;
  }
  return { toRelease, reportOnly, unitsByProduct };
};

// One transaction per item, re-checked inside it: running the script twice,
// or while a user is active, can't return the same units twice. The units go
// back to the product's source after the delete commits; a failure there is
// thrown so whoever runs the script sees it.
export const releaseCartItem = async (itemId: string): Promise<boolean> => {
  const item = await db.runTransaction(async (tx): Promise<CartItem | null> => {
    const itemRef = db.collection(CART_COLLECTION).doc(itemId);
    const itemDoc = await tx.get(itemRef);
    const found = itemDoc.data() as CartItem | undefined;
    if (!found || hasOwner(found)) {
      return null;
    }
    if (found.orderId != null) {
      const orderDoc = await tx.get(db.collection(ORDERS_COLLECTION).doc(found.orderId));
      if (orderDoc.exists) {
        return null;
      }
    }
    tx.delete(itemRef);
    return found;
  });
  if (!item) {
    return false;
  }
  for (const { sourceKey, reservation } of reservationsToRelease({ ...item, id: itemId })) {
    await getCatalogSource(sourceKey).release(reservation, `${reservation.reservationId}-release`);
  }
  return true;
};

export const cleanupOrphanCartItems = async ({
  apply = false,
  cartIds,
}: { apply?: boolean; cartIds?: string[] } = {}) => {
  const found = await findOrphanCartItems({ cartIds });
  let released = 0;
  if (apply) {
    for (const item of found.toRelease) {
      if (await releaseCartItem(item.id)) released += 1;
    }
  }
  return { ...found, released };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const apply = process.argv.includes("--apply");
  const { toRelease, reportOnly, unitsByProduct, released } = await cleanupOrphanCartItems({
    apply,
  });
  console.log(`Project: ${process.env.FIRESTORE_PROJECT_ID ?? "(emulator default)"}`);
  console.log(`Mode: ${apply ? "APPLY" : "dry run (pass --apply to write)"}`);
  console.log(`Cart items without an owner to release: ${toRelease.length}`);
  for (const [productId, units] of Object.entries(unitsByProduct)) {
    console.log(`  product ${productId}: +${units} units`);
  }
  console.log(`Cart items without an owner left untouched (review by hand): ${reportOnly.length}`);
  for (const item of reportOnly) {
    console.log(`  item ${item.id}: order ${item.orderId} is ${item.orderStatus}`);
  }
  if (apply) {
    console.log(`Released: ${released}`);
  }
  process.exit(0);
}
