import type { DocumentSnapshot, Query } from "firebase-admin/firestore";
import {
  callSource,
  canonicalProductId,
  DEFAULT_SOURCE_KEY,
  getCatalogSource,
  OutOfStockError,
  parseProductId,
  toGlobalProductId,
  type Reservation,
} from "#src/catalog/index";
import { runInventoryTasks } from "#src/catalog/inventoryQueue";
import db from "#src/config/firestore";
import type { PriceQuote } from "#src/pricing/index";
import type {
  CartItem,
  CartItemReservation,
  Order,
  OrderStatus,
  Page,
  Product,
} from "#src/types/models";
import { queueInventoryTasks, type InventoryTaskDraft } from "./inventoryTasks.ts";
import { isOrderOpen } from "./orderStatus.ts";
import { paginateQuery } from "./pagination.ts";
import { runTransaction } from "./transactions.ts";
import { logger } from "#src/utils/logger";

const COLLECTION = "cartItems";
const toDate = (value: unknown): Date | null =>
  value == null ? null : value instanceof Date ? value : (value as { toDate(): Date }).toDate();

const toCartItem = (doc: DocumentSnapshot): CartItem => {
  const item = { id: doc.id, ...doc.data() } as CartItem;
  if (item.reservations) {
    item.reservations = item.reservations.map((r) => ({ ...r, expiresAt: toDate(r.expiresAt) }));
  }
  return item;
};

// The reservations to give back for an item. Units added before
// reservations existed have none; they go back under a stable id, so
// releasing the item twice is still a no-op.
export const reservationsToRelease = (item: CartItem) => {
  const { sourceKey, localId } = parseProductId(String(item.productId));
  const held: CartItemReservation[] = [...(item.reservations ?? [])];
  const unreserved = item.quantity - held.reduce((sum, r) => sum + r.quantity, 0);
  if (unreserved > 0) {
    held.push({ reservationId: `cartItem-${item.id}`, quantity: unreserved, expiresAt: null });
  }
  return held.map((r) => ({ sourceKey, reservation: { ...r, localId } }));
};

// The outbox tasks that give an item's units back.
export const releaseTasks = (
  item: CartItem,
  reason: string,
  orderId: string | null = item.orderId
): InventoryTaskDraft[] =>
  reservationsToRelease(item).map(({ sourceKey, reservation }) => ({
    action: "release",
    sourceKey,
    reservation,
    reason,
    orderId,
  }));

// The outbox tasks that mark a paid item's units sold. Units added before
// reservations existed left the stock for good when they were added, so
// they have nothing to confirm.
export const confirmTasks = (item: CartItem, orderId: string): InventoryTaskDraft[] => {
  const { sourceKey, localId } = parseProductId(String(item.productId));
  return (item.reservations ?? []).map((r) => ({
    action: "confirm",
    sourceKey,
    reservation: { ...r, localId },
    reason: "orderComplete",
    orderId,
  }));
};

// Kept under its old name: callers and tests catch it as InsufficientStockError.
export { OutOfStockError as InsufficientStockError };

// The values a product's items can hold in productId: its global id and,
// for Firestore items not migrated yet, the bare document id.
const storedProductIds = (id: string): string[] => {
  const { sourceKey, localId } = parseProductId(id);
  const globalId = toGlobalProductId(sourceKey, localId);
  return sourceKey === DEFAULT_SOURCE_KEY ? [globalId, localId] : [globalId];
};

export const getCart = async ({
  cartId,
  orderId,
  productId,
}: { cartId?: string; orderId?: string | null; productId?: string } = {}): Promise<CartItem[]> => {
  let query: Query = db.collection(COLLECTION);
  if (cartId !== undefined) query = query.where("cartId", "==", cartId);
  if (orderId !== undefined) query = query.where("orderId", "==", orderId);
  if (productId !== undefined) query = query.where("productId", "in", storedProductIds(productId));
  const snapshot = await query.get();
  return snapshot.docs.map(toCartItem);
};

// Must match COLLECTION in db/orders.ts: removing an ordered item reads its
// order inside the same transaction.
const ORDERS_COLLECTION = "orders";

export class OrderItemLockedError extends Error {
  orderId: string;
  status: OrderStatus;
  constructor(orderId: string, status: OrderStatus) {
    super(`Order ${orderId} is ${status}; its items can't change`);
    this.name = "OrderItemLockedError";
    this.orderId = orderId;
    this.status = status;
  }
}

export class CartNotOwnedError extends Error {
  cartId: string;
  constructor(cartId: string) {
    super(`Cart ${cartId} belongs to another user`);
    this.name = "CartNotOwnedError";
    this.cartId = cartId;
  }
}

// The carts query: the user's free items (not yet in an order), one page at a time.
export const listCartItemsWithoutOrder = async (
  {
    cartId,
    productId,
    userId,
  }: { cartId?: string | null; productId?: string | null; userId?: string } = {},
  page: Page = {}
) => {
  let query: Query = db.collection(COLLECTION).where("orderId", "==", null);
  // Like getOrders (H2): a user only ever sees their own cart items.
  if (userId !== undefined) query = query.where("userId", "==", userId);
  if (cartId !== undefined) query = query.where("cartId", "==", cartId);
  if (productId != null) query = query.where("productId", "in", storedProductIds(productId));
  return paginateQuery(query, page, toCartItem);
};

// The cartId is generated by the client, so the first user to add an item
// owns that cart; anyone else gets CartNotOwnedError instead of writing into it.
export interface AddToCartInput {
  cartId: string;
  productId: string;
  quantity: number;
  orderId?: string | null;
}

// The copy of the product an item keeps, so paying for it never depends on
// the source answering again. The price comes from the quote (already in the
// settlement currency) when there is one.
const productSnapshot = (product: Product, sourceKey: string, quote?: PriceQuote) => ({
  sourceKey,
  title: product.title ?? null,
  image: product.image ?? null,
  unitPrice: quote?.unitPrice ?? product.unitPrice,
  currency: quote?.currency ?? product.currency ?? null,
  originalUnitPrice: quote?.originalUnitPrice ?? null,
  originalCurrency: quote?.originalCurrency ?? null,
  exchangeRate: quote?.exchangeRate ?? null,
  rateAsOf: quote?.rateAsOf ?? null,
});

export const addToCart = async (
  product: Product,
  input: AddToCartInput,
  userId: string | null = null,
  quote?: PriceQuote
): Promise<CartItem> => {
  const cartQuery = db.collection(COLLECTION).where("cartId", "==", input.cartId);
  const isForeign = (docs: DocumentSnapshot[]) =>
    docs.some((doc) => doc.get("userId") !== userId);

  // Checked before reserving so someone else's cart answers "not found"
  // even when the product is out of stock, as it did before; the
  // transaction below checks it again.
  if (isForeign((await cartQuery.get()).docs)) {
    throw new CartNotOwnedError(input.cartId);
  }

  // The stock belongs to the product's source, so it can't be part of the
  // cart's Firestore transaction: the units are reserved first and put back
  // if the cart write fails.
  // The key names the item this call creates, so a retried reserve finds
  // the reservation it already made instead of taking the units again.
  const { sourceKey, localId } = parseProductId(String(product.id));
  const source = getCatalogSource(sourceKey);
  const newItemId = db.collection(COLLECTION).doc().id;
  const reservation = await callSource(source, () =>
    source.reserve(localId, input.quantity, `cartItem-${newItemId}-reserve`)
  );
  try {
    return await writeCartItem(
      { ...input, productId: toGlobalProductId(sourceKey, localId) },
      productSnapshot(product, sourceKey, quote),
      newItemId,
      {
        reservationId: reservation.reservationId,
        quantity: reservation.quantity,
        expiresAt: reservation.expiresAt,
      },
      userId,
      cartQuery,
      isForeign
    );
  } catch (err) {
    // No item holds the units, so nothing else would give them back before
    // the sweep finds the reservation expired.
    await queueAndRunRelease(sourceKey, reservation, input.orderId ?? null);
    throw err;
  }
};

const queueAndRunRelease = async (
  sourceKey: string,
  reservation: Reservation,
  orderId: string | null
) => {
  try {
    const ids = await runTransaction((tx) =>
      queueInventoryTasks(tx, [
        { action: "release", sourceKey, reservation, reason: "addToCart failed after reserving", orderId },
      ])
    );
    await runInventoryTasks(ids);
  } catch (err) {
    logger.error("Could not queue the release of reserved stock", {
      sourceKey,
      productId: reservation.localId,
      quantity: reservation.quantity,
      reservationId: reservation.reservationId,
      error: (err as Error).message,
    });
  }
};

// input.productId is already the global id; items written before global ids
// hold the bare one, so both forms count as the same product.
const writeCartItem = (
  input: AddToCartInput,
  snapshot: ReturnType<typeof productSnapshot>,
  newItemId: string,
  reservation: CartItemReservation,
  userId: string | null,
  cartQuery: Query,
  isForeign: (docs: DocumentSnapshot[]) => boolean
): Promise<CartItem> =>
  runTransaction(async (tx) => {
    const cartSnapshot = await tx.get(cartQuery);

    if (isForeign(cartSnapshot.docs)) {
      throw new CartNotOwnedError(input.cartId);
    }
    const existingDocs = cartSnapshot.docs.filter((doc) => {
      const item = doc.data();
      return (
        canonicalProductId(String(item.productId)) === input.productId &&
        item.orderId === (input.orderId ?? null)
      );
    });

    if (existingDocs.length > 0) {
      const existingDoc = existingDocs[0];
      const existingItem = toCartItem(existingDoc);
      const updates = {
        quantity: existingItem.quantity + input.quantity,
        subtotal: existingItem.subtotal + snapshot.unitPrice * input.quantity,
        // An item from before reservations keeps its old units unreserved;
        // only the units added now get a reservation.
        reservations: [...(existingItem.reservations ?? []), reservation],
        // Lets the sweep find the item that holds a reservation.
        reservationIds: [...(existingItem.reservationIds ?? []), reservation.reservationId],
      };
      tx.update(existingDoc.ref, updates);
      return { ...existingItem, ...updates };
    }

    const docRef = db.collection(COLLECTION).doc(newItemId);
    const newItem = {
      cartId: input.cartId,
      // Adding to an existing order puts the item straight into it, so it
      // counts in the order total (it used to stay outside, unpaid).
      orderId: input.orderId ?? null,
      userId,
      productId: input.productId,
      quantity: input.quantity,
      subtotal: snapshot.unitPrice * input.quantity,
      ...snapshot,
      reservations: [reservation],
      reservationIds: [reservation.reservationId],
    };
    tx.set(docRef, newItem);
    return { id: docRef.id, ...newItem };
  });

// addToCart reserved these units; removing the item queues their release in
// the same transaction as the delete, so they come back exactly once even if
// the source is down right now (the inventory job retries it).
// Returns the removed item, or null both for a missing item and for someone
// else's, so the caller can't tell which (same reasoning as H2).
export const removeFromCart = async (input: { id: string }, userId: string): Promise<CartItem | null> => {
  const removed = await runTransaction(async (tx): Promise<{ item: CartItem; taskIds: string[] } | null> => {
    const docRef = db.collection(COLLECTION).doc(input.id);
    const doc = await tx.get(docRef);
    if (!doc.exists || doc.get("userId") !== userId) {
      return null;
    }
    const item = toCartItem(doc);
    // A paid or cancelled order's items are settled: removing one would put
    // sold (or already returned) units back in stock.
    if (item.orderId) {
      const orderDoc = await tx.get(db.collection(ORDERS_COLLECTION).doc(item.orderId));
      const order = orderDoc.data() as Order | undefined;
      if (order && !isOrderOpen(order)) {
        throw new OrderItemLockedError(item.orderId, order.status);
      }
    }
    const taskIds = await queueInventoryTasks(tx, releaseTasks(item, "removeFromCart"));
    tx.delete(docRef);
    return { item, taskIds };
  });
  if (!removed) {
    return null;
  }
  await runInventoryTasks(removed.taskIds);
  return removed.item;
};

// The free items an anonymous user holds, in any cart: what a merge would move.
export const getFreeCartItems = async (userId: string): Promise<CartItem[]> => {
  const snapshot = await db
    .collection(COLLECTION)
    .where("userId", "==", userId)
    .where("orderId", "==", null)
    .get();
  return snapshot.docs.map(toCartItem);
};

export interface MergedCart {
  // The account's free items in the cart after the merge.
  items: CartItem[];
  // Units given back because they didn't fit, per product.
  released: { productId: string; quantity: number }[];
}

// Moves an anonymous user's free items to an account's cart. Moved units keep
// their reservations, so no stock is touched and none can run out: only the
// purchase limit caps them (maxUnits, by global product id; a product that is
// gone has no cap, and paying for it is refused later). Sources release whole
// reservations, so one that doesn't fit is given back entirely, and the app
// can add the difference again.
// A repeat finds nothing to move, so it changes nothing. The cart can only
// hold the account's items and the free ones being moved: anything else
// (another user's, or an order of the anonymous user) raises
// CartNotOwnedError, because the account could never use that cart.
export const mergeCartItems = async (
  { anonymousUserId, userId, cartId }: { anonymousUserId: string; userId: string; cartId: string },
  maxUnits: ReadonlyMap<string, number>
): Promise<MergedCart> => {
  const merged = await runTransaction(async (tx) => {
    const cartSnapshot = await tx.get(db.collection(COLLECTION).where("cartId", "==", cartId));
    const anonymousSnapshot = await tx.get(
      db
        .collection(COLLECTION)
        .where("userId", "==", anonymousUserId)
        .where("orderId", "==", null)
    );
    const isUsable = (doc: DocumentSnapshot) =>
      doc.get("userId") === userId ||
      (doc.get("userId") === anonymousUserId && doc.get("orderId") === null);
    if (!cartSnapshot.docs.every(isUsable)) {
      throw new CartNotOwnedError(cartId);
    }

    // The account's free items by product, updated as items land on them.
    const items = new Map(
      cartSnapshot.docs
        .filter((doc) => doc.get("userId") === userId && doc.get("orderId") === null)
        .map((doc) => {
          const item = toCartItem(doc);
          return [canonicalProductId(String(item.productId)), item] as const;
        })
    );
    const writes = new Map<string, Partial<CartItem>>();
    const deletes: string[] = [];
    const drafts: InventoryTaskDraft[] = [];
    const released = new Map<string, MergedCart["released"][number]>();

    for (const doc of anonymousSnapshot.docs) {
      const item = toCartItem(doc);
      const productId = canonicalProductId(String(item.productId));
      const target = items.get(productId);
      const max = maxUnits.get(productId) ?? Infinity;
      let units = target?.quantity ?? 0;
      const kept: CartItemReservation[] = [];
      let keptUnits = 0;
      for (const { sourceKey, reservation } of reservationsToRelease(item)) {
        if (units + reservation.quantity <= max) {
          units += reservation.quantity;
          keptUnits += reservation.quantity;
          // Units from before reservations hold none, and stay that way.
          kept.push(...(item.reservations ?? []).filter((r) => r.reservationId === reservation.reservationId));
          continue;
        }
        drafts.push({
          action: "release",
          sourceKey,
          reservation,
          reason: "mergeAnonymousCart",
          orderId: null,
        });
        released.set(productId, {
          productId,
          quantity: (released.get(productId)?.quantity ?? 0) + reservation.quantity,
        });
      }

      if (keptUnits === 0) {
        deletes.push(doc.id);
        continue;
      }
      const landed: CartItem = target
        ? {
            ...target,
            quantity: units,
            subtotal: target.subtotal + item.unitPrice * keptUnits,
            reservations: [...(target.reservations ?? []), ...kept],
            reservationIds: [...(target.reservationIds ?? []), ...kept.map((r) => r.reservationId)],
          }
        : {
            ...item,
            cartId,
            userId,
            quantity: keptUnits,
            subtotal: item.unitPrice * keptUnits,
            reservations: kept,
            reservationIds: kept.map((r) => r.reservationId),
          };
      items.set(productId, landed);
      if (target) deletes.push(doc.id);
      const { id, ...fields } = landed;
      writes.set(id, fields);
    }

    const taskIds = await queueInventoryTasks(tx, drafts);
    const ref = (id: string) => db.collection(COLLECTION).doc(id);
    writes.forEach((fields, id) => tx.update(ref(id), fields));
    deletes.forEach((id) => tx.delete(ref(id)));
    return { items: [...items.values()], released: [...released.values()], taskIds };
  });
  await runInventoryTasks(merged.taskIds);
  return { items: merged.items, released: merged.released };
};

const FIRESTORE_IN_QUERY_LIMIT = 30;

// A single round of reads for N orderIds (vs. N queries), used by the
// totals DataLoader to avoid the N+1 problem (H10). Firestore limits "in"
// to 30 values, so this splits into chunks when needed.
export const getCartByOrderIds = async (orderIds: readonly string[]): Promise<CartItem[]> => {
  const uniqueIds = [...new Set(orderIds)];
  if (uniqueIds.length === 0) {
    return [];
  }
  const chunks: string[][] = [];
  for (let i = 0; i < uniqueIds.length; i += FIRESTORE_IN_QUERY_LIMIT) {
    chunks.push(uniqueIds.slice(i, i + FIRESTORE_IN_QUERY_LIMIT));
  }
  const snapshots = await Promise.all(
    chunks.map((chunk) => db.collection(COLLECTION).where("orderId", "in", chunk).get())
  );
  return snapshots.flatMap((snapshot) => snapshot.docs.map(toCartItem));
};

export const updateCartItems = async (cartId: string, orderId: string): Promise<boolean> => {
  const snapshot = await db
    .collection(COLLECTION)
    .where("cartId", "==", cartId)
    .where("orderId", "==", null)
    .get();
  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.update(doc.ref, { orderId }));
  await batch.commit();
  return true;
};
