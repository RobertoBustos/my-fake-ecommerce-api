import type { Connection, Page, Product } from "../types/models.js";
import { listProducts } from "../db/products.js";
import type { CatalogSource, SourceProduct } from "./ports.js";
import { UnknownSourceError } from "./ports.js";
import { parseProductId, toGlobalProductId } from "./productId.js";
import { DEFAULT_SOURCE_KEY, getCatalogSource } from "./registry.js";

export {
  OutOfStockError,
  ReservationExpiredError,
  SourceUnavailableError,
  UnknownSourceError,
} from "./ports.js";
export type { CatalogSource, Reservation, SourceProduct } from "./ports.js";
export { canonicalProductId, parseProductId, toGlobalProductId } from "./productId.js";
export type { ProductRef } from "./productId.js";
export { DEFAULT_SOURCE_KEY, getCatalogSource } from "./registry.js";
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
      for (const product of await source.getProducts([...new Set(localIds)])) {
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

// The products query. Until the catalog has its own index, every listed
// product comes from the Firestore source, so the page is read there and
// only the ids are turned into global ones; cursors stay as they were.
export const listCatalogProducts = async (
  { id, category }: { id?: string | null; category?: string | null } = {},
  page: Page = {}
): Promise<Connection<Product>> => {
  const source = getCatalogSource(DEFAULT_SOURCE_KEY);
  let localId: string | undefined;
  if (id != null) {
    const ref = resolveProductId(id);
    if (ref.source.key !== source.key) {
      return { edges: [], pageInfo: { hasNextPage: false, endCursor: null } };
    }
    localId = ref.localId;
  }
  const connection = await listProducts(
    { id: localId, category: category ?? undefined },
    page
  );
  return {
    ...connection,
    edges: connection.edges.map((edge) => ({
      ...edge,
      node: {
        ...edge.node,
        id: toGlobalProductId(source.key, edge.node.id),
        source: source.displayName,
      },
    })),
  };
};
