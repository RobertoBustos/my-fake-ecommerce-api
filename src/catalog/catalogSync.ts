import env from "../config/env.js";
import {
  deleteCatalogEntries,
  getCatalogSyncState,
  listAllCatalogEntries,
  listCatalogEntryIds,
  saveCatalogSyncState,
  upsertCatalogEntries,
  type CatalogEntry,
} from "../db/catalogIndex.js";
import { getPricingSettings } from "../pricing/settings.js";
import { getConfiguredSearchIndex } from "../search/registry.js";
import type { SearchIndex } from "../search/ports.js";
import { logger } from "../utils/logger.js";
import type { CatalogSource, ChangedProducts, SourceProduct } from "./ports.js";
import { toGlobalProductId } from "./productId.js";
import { listEnabledSources } from "./registry.js";
import { createSearchFeed, type SearchFeed } from "./searchFeed.js";

// Keeps the catalog index (db/catalogIndex.ts) in step with every switched-on
// source:
//   - pull: listChanged(since) from where the last run left off, writing
//     each page and saving its cursor, so a run that dies resumes there.
//   - reconciliation: a full pass that also deletes from the index what the
//     source no longer has. It runs on the first sync of a source and then
//     every CATALOG_RECONCILE_HOURS (24 by default), or when asked for.
// A switched-off source is neither pulled nor reconciled; its entries stay
// in the index, and reading the index skips sources that are off.
//
// The search index (catalog/searchFeed.ts) is fed in the same pass, after
// the catalog index: every pulled page, and after a reconciliation the whole
// catalog index at once.

const PAGE_SIZE = 100;
const DEFAULT_RECONCILE_HOURS = 24;

const reconcileEveryMs = () => {
  const hours = Number(env.CATALOG_RECONCILE_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_RECONCILE_HOURS) * 3_600_000;
};

const latest = (a: Date | null, b: Date | null) => (a === null ? b : b === null || a >= b ? a : b);

const latestUpdate = (items: SourceProduct[], from: Date | null) =>
  items.reduce((max, item) => latest(max, item.updatedAt), from);

export const toCatalogEntry = (sourceKey: string, product: SourceProduct, syncedAt: Date): CatalogEntry => ({
  id: toGlobalProductId(sourceKey, product.localId),
  sourceKey,
  localId: product.localId,
  title: product.title,
  description: product.description,
  category: product.category,
  image: product.image,
  currency: product.currency,
  unitPrice: product.unitPrice,
  purchaseLimits: product.purchaseLimits,
  available: product.available,
  sourceUpdatedAt: product.updatedAt,
  syncedAt,
});

// Writes one batch of changes of a source to the index, and then to the
// search index when there is a feed. The pull calls it for every page, and a
// source that pushes its changes (subscribeChanges) would call it for every
// event.
export const applyCatalogChanges = async (
  sourceKey: string,
  { items, deletedIds }: Pick<ChangedProducts, "items" | "deletedIds">,
  now = new Date(),
  search: SearchFeed | null = null
) => {
  const entries = items.map((item) => toCatalogEntry(sourceKey, item, now));
  const deleted = deletedIds.map((localId) => toGlobalProductId(sourceKey, localId));
  await upsertCatalogEntries(entries);
  await deleteCatalogEntries(deleted);
  await search?.apply(sourceKey, entries, deleted);
  return { upserted: items.length, deleted: deletedIds.length };
};

export interface SourceSyncResult {
  sourceKey: string;
  mode: "pull" | "reconcile";
  upserted: number;
  deleted: number;
  resumed: boolean;
}

export const pullCatalogSource = async (
  source: CatalogSource,
  { now = new Date(), search = null }: { now?: Date; search?: SearchFeed | null } = {}
): Promise<SourceSyncResult> => {
  const state = await getCatalogSyncState(source.key);
  const resumed = Boolean(state?.cursor);
  const runSince = resumed ? (state?.runSince ?? null) : (state?.since ?? null);
  let pendingSince = resumed ? (state?.pendingSince ?? null) : runSince;
  let cursor = state?.cursor ?? undefined;
  const result: SourceSyncResult = { sourceKey: source.key, mode: "pull", upserted: 0, deleted: 0, resumed };
  do {
    const page = await source.listChanged(runSince, { cursor, limit: PAGE_SIZE });
    const applied = await applyCatalogChanges(source.key, page, now, search);
    result.upserted += applied.upserted;
    result.deleted += applied.deleted;
    pendingSince = latestUpdate(page.items, pendingSince);
    cursor = page.nextCursor;
    await saveCatalogSyncState(source.key, { cursor: cursor ?? null, runSince, pendingSince });
  } while (cursor);
  await saveCatalogSyncState(source.key, {
    since: pendingSince,
    cursor: null,
    runSince: null,
    pendingSince: null,
    lastSyncedAt: now,
  });
  return result;
};

// Every product of the source, written again, and every entry of the index
// the source no longer lists, deleted. It doesn't write the search index:
// syncCatalog replaces it whole afterwards (reconcileSearchIndex), which a
// single source can't do without dropping the others' products.
export const reconcileCatalogSource = async (
  source: CatalogSource,
  { now = new Date() } = {}
): Promise<SourceSyncResult> => {
  const seen = new Set<string>();
  let newest: Date | null = null;
  let cursor: string | undefined;
  const result: SourceSyncResult = { sourceKey: source.key, mode: "reconcile", upserted: 0, deleted: 0, resumed: false };
  do {
    const page = await source.listChanged(null, { cursor, limit: PAGE_SIZE });
    const applied = await applyCatalogChanges(source.key, page, now);
    result.upserted += applied.upserted;
    result.deleted += applied.deleted;
    for (const item of page.items) seen.add(toGlobalProductId(source.key, item.localId));
    newest = latestUpdate(page.items, newest);
    cursor = page.nextCursor;
  } while (cursor);

  const gone = (await listCatalogEntryIds(source.key)).filter((id) => !seen.has(id));
  await deleteCatalogEntries(gone);
  result.deleted += gone.length;

  // Everything up to the newest updatedAt seen is in the index now.
  await saveCatalogSyncState(source.key, {
    since: newest,
    cursor: null,
    runSince: null,
    pendingSince: null,
    lastSyncedAt: now,
    lastReconciledAt: now,
  });
  return result;
};

// The search index becomes a copy of the whole catalog index, every source
// included: a switched-off source's products are filtered out when
// searching, like when reading the catalog index.
export const reconcileSearchIndex = async (search: SearchFeed) => search.replaceAll(await listAllCatalogEntries());

export interface CatalogSyncOptions {
  now?: Date;
  // Reconcile every source in this run, whenever it was last reconciled.
  reconcile?: boolean;
  // Only these sources (all switched-on ones by default).
  sourceKeys?: string[];
  // The search index to feed: the one SEARCH_ENGINE names by default, none
  // while it is unset.
  searchIndex?: SearchIndex | null;
}

// One run of the catalog sync job. A source that fails is logged and the
// rest still sync; the caller sees it in `failed`. A search index write that
// fails is logged as a WARNING and listed in `searchFailed`, and never fails
// the run: the next reconciliation repairs it.
export const syncCatalog = async ({
  now = new Date(),
  reconcile = false,
  sourceKeys,
  searchIndex = getConfiguredSearchIndex(),
}: CatalogSyncOptions = {}) => {
  const sources = listEnabledSources();
  const unknown = (sourceKeys ?? []).filter((key) => !sources.some((source) => source.key === key));
  if (unknown.length > 0) {
    throw new Error(`Catalog sources not switched on: ${unknown.join(", ")}`);
  }
  const selected = sourceKeys ? sources.filter((source) => sourceKeys.includes(source.key)) : sources;
  const search = searchIndex
    ? createSearchFeed(searchIndex, (await getPricingSettings()).settlementCurrency)
    : null;

  const synced: SourceSyncResult[] = [];
  const failed: { sourceKey: string; error: string }[] = [];
  for (const source of selected) {
    try {
      const state = await getCatalogSyncState(source.key);
      const due =
        reconcile ||
        !state?.lastReconciledAt ||
        now.getTime() - state.lastReconciledAt.getTime() >= reconcileEveryMs();
      synced.push(
        due ? await reconcileCatalogSource(source, { now }) : await pullCatalogSource(source, { now, search })
      );
    } catch (err) {
      const error = (err as Error).message;
      logger.error("Catalog sync failed", { sourceKey: source.key, error });
      failed.push({ sourceKey: source.key, error });
    }
  }
  if (search && synced.some((result) => result.mode === "reconcile")) await reconcileSearchIndex(search);
  return { synced, failed, searchFailed: search?.failed ?? [] };
};
