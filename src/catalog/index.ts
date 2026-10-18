import { GraphQLError } from "graphql";
import { getCatalogEntries, listCatalogEntries, type CatalogEntry } from "../db/catalogIndex.js";
import { TransactionContentionError } from "../db/transactions.js";
import type { Connection, Page, Product } from "../types/models.js";
import { logger } from "../utils/logger.js";
import type { CatalogSource, SourceProduct } from "./ports.js";
import {
  OutOfStockError,
  ReservationExpiredError,
  SourceUnavailableError,
  UnknownSourceError,
} from "./ports.js";
import { canonicalProductId, parseProductId, toGlobalProductId } from "./productId.js";
import { getCatalogSource, listEnabledSources } from "./registry.js";

export {
  OutOfStockError,
  ReservationExpiredError,
  SourceUnavailableError,
  UnknownSourceError,
} from "./ports.js";
export type { CatalogSource, Reservation, SourceProduct } from "./ports.js";
export { canonicalProductId, parseProductId, toGlobalProductId } from "./productId.js";
export type { ProductRef } from "./productId.js";
export { DEFAULT_SOURCE_KEY, getCatalogSource, listEnabledSources } from "./registry.js";
export { withCoreReservations } from "./coreReservations.js";
export { reservationTtlMs } from "./reservationTtl.js";
export {
  processInventoryTasks,
  retryInventoryTask,
  runInventoryTask,
  runInventoryTasks,
} from "./inventoryQueue.js";

// The shape the rest of the API (and the GraphQL Product type) uses.
export const toProduct = (
  source: Pick<CatalogSource, "key" | "displayName">,
  { localId, available, updatedAt: _updatedAt, ...rest }: SourceProduct
): Product => ({
  ...rest,
  id: toGlobalProductId(source.key, localId),
  stock: available,
  source: source.displayName,
});

// Errors the callers already turn into an answer for the client.
const isExpected = (err: unknown) =>
  err instanceof GraphQLError ||
  err instanceof OutOfStockError ||
  err instanceof ReservationExpiredError ||
  err instanceof SourceUnavailableError ||
  err instanceof TransactionContentionError;

// Runs a live call to a source. Anything else it throws (a timeout, a
// refused connection, a bug in its adapter) means the source can't answer
// right now: it becomes SourceUnavailableError, which the services answer
// with CONFLICT and retryable, and is logged since the client won't see it.
export const callSource = async <T>(source: Pick<CatalogSource, "key">, call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (err) {
    if (isExpected(err)) throw err;
    logger.warn("Catalog source call failed", { sourceKey: source.key, error: (err as Error).message });
    throw new SourceUnavailableError(source.key, err);
  }
};

// The source that owns a product id, and the product's id inside it. An
// unknown or switched-off source answers NOT_FOUND, like a missing product.
export const resolveProductId = (id: string): { source: CatalogSource; localId: string } => {
  const { sourceKey, localId } = parseProductId(id);
  return { source: getCatalogSource(sourceKey), localId };
};

// One result per id, in the same order, null when the product doesn't exist
// or its source is unknown. Ids of one source are fetched in a single call.
export const getCatalogProducts = async (ids: readonly string[]): Promise<(Product | null)[]> => {
  const bySource = new Map<string, { source: CatalogSource; localIds: string[] }>();
  const refs = ids.map((id) => {
    try {
      const { source, localId } = resolveProductId(id);
      const group = bySource.get(source.key) ?? { source, localIds: [] };
      group.localIds.push(localId);
      bySource.set(source.key, group);
      return { sourceKey: source.key, localId };
    } catch (err) {
      if (err instanceof UnknownSourceError) return null;
      throw err;
    }
  });

  const found = new Map<string, Product>();
  await Promise.all(
    [...bySource.values()].map(async ({ source, localIds }) => {
      for (const product of await callSource(source, () => source.getProducts([...new Set(localIds)]))) {
        found.set(`${source.key}:${product.localId}`, toProduct(source, product));
      }
    })
  );
  return refs.map((ref) => (ref ? found.get(`${ref.sourceKey}:${ref.localId}`) ?? null : null));
};

// Throws NOT_FOUND for an unknown source; null for a missing product.
export const getCatalogProduct = async (id: string): Promise<Product | null> => {
  resolveProductId(id);
  return (await getCatalogProducts([id]))[0];
};

// A product as the catalog index has it. stock is the source's count at
// the last sync: good enough to show, never to sell (addToCart asks the
// source).
const fromEntry = (entry: CatalogEntry, displayName: string): Product => ({
  id: entry.id,
  title: entry.title,
  description: entry.description,
  category: entry.category,
  image: entry.image,
  stock: entry.available,
  currency: entry.currency,
  unitPrice: entry.unitPrice,
  purchaseLimits: entry.purchaseLimits,
  source: displayName,
});

const enabledDisplayNames = () =>
  new Map(listEnabledSources().map((source) => [source.key, source.displayName]));

// The product loader (CartItem.product): from the index, so showing a cart
// doesn't call every source. A product of a switched-off source is null, as
// before; one the index doesn't hold yet (added to its source since the
// last sync) is asked to its source.
export const getIndexedCatalogProducts = async (ids: readonly string[]): Promise<(Product | null)[]> => {
  const names = enabledDisplayNames();
  const globalIds = ids.map((id) => canonicalProductId(id));
  const entries = await getCatalogEntries([...new Set(globalIds)]);
  const byId = new Map(entries.flatMap((entry) => (entry ? [[entry.id, entry] as const] : [])));

  const results = globalIds.map((id): Product | null | undefined => {
    const entry = byId.get(id);
    if (!entry) return undefined;
    const name = names.get(entry.sourceKey);
    return name === undefined ? null : fromEntry(entry, name);
  });
  const missing = globalIds.filter((_, i) => results[i] === undefined);
  if (missing.length > 0) {
    const live = new Map((await getCatalogProducts(missing)).flatMap((p) => (p ? [[p.id, p] as const] : [])));
    return results.map((result, i) => (result === undefined ? (live.get(globalIds[i]) ?? null) : result));
  }
  return results as (Product | null)[];
};

// The products query, served from the catalog index: one Firestore query
// whatever the number of sources, and a source that is down doesn't hide its
// products. Only switched-on sources are listed. Cursors are the global
// product ids in base64.
export const listCatalogProducts = async (
  { id, category }: { id?: string | null; category?: string | null } = {},
  page: Page = {}
): Promise<Connection<Product>> => {
  const names = enabledDisplayNames();
  let globalId: string | undefined;
  if (id != null) {
    // An unknown or switched-off source answers NOT_FOUND, as before.
    const { source, localId } = resolveProductId(id);
    globalId = toGlobalProductId(source.key, localId);
  }
  const connection = await listCatalogEntries(
    { sourceKeys: [...names.keys()], id: globalId, category: category ?? undefined },
    page
  );
  return {
    ...connection,
    edges: connection.edges.map((edge) => ({
      ...edge,
      node: fromEntry(edge.node, names.get(edge.node.sourceKey) as string),
    })),
  };
};
