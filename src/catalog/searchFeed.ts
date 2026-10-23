import type { CatalogEntry } from "../db/catalogIndex.js";
import type { SearchDoc, SearchIndex } from "../search/ports.js";
import { logger } from "../utils/logger.js";

// The search index is one more copy of the catalog index, fed by the catalog
// sync in the same pass: each page the sync writes to the catalog index goes
// to the search index right after, and a reconciliation replaces the whole
// search index with the catalog index.
//
// The catalog index comes first and the search index never stops the sync:
// a failed search write is logged as a WARNING and the next reconciliation
// repairs it.

// The search document of a catalog entry, or null while it can't be one:
// its price must already be in the settlement currency, because the search
// index filters and sorts every product by that one price. Today every
// product is in MXN; converting the others comes with indexing settlement
// prices.
export const toSearchDoc = (entry: CatalogEntry, settlementCurrency: string): SearchDoc | null =>
  entry.currency !== settlementCurrency
    ? null
    : {
        id: entry.id,
        sourceKey: entry.sourceKey,
        title: entry.title,
        description: entry.description,
        category: entry.category,
        settlementPrice: entry.unitPrice,
        inStock: entry.available > 0,
      };

export interface SearchFeed {
  // Writes one page of the sync: the entries it wrote and the ids it deleted
  // from the catalog index.
  apply(sourceKey: string, entries: CatalogEntry[], deletedIds: string[]): Promise<void>;
  // Replaces the search index with these entries: every entry of the
  // catalog index, of every source.
  replaceAll(entries: CatalogEntry[]): Promise<void>;
  // What failed in this run: a source key, or "reconcile" for replaceAll.
  readonly failed: string[];
}

export const createSearchFeed = (index: SearchIndex, settlementCurrency: string): SearchFeed => {
  const failed: string[] = [];
  const attempt = async (what: string, fields: Record<string, unknown>, write: () => Promise<void>) => {
    try {
      await write();
    } catch (err) {
      const error = (err as Error).message;
      const cause = (err as Error).cause instanceof Error ? ((err as Error).cause as Error).message : undefined;
      logger.warn("Search index sync failed", { ...fields, engine: index.key, error, cause });
      failed.push(what);
    }
  };

  return {
    failed,

    async apply(sourceKey, entries, deletedIds) {
      const docs: SearchDoc[] = [];
      // An entry that can't be a search document anymore (its currency
      // changed) leaves the search index.
      const removed = [...deletedIds];
      for (const entry of entries) {
        const doc = toSearchDoc(entry, settlementCurrency);
        if (doc) docs.push(doc);
        else removed.push(entry.id);
      }
      await attempt(sourceKey, { sourceKey }, async () => {
        await index.upsert(docs);
        await index.delete(removed);
      });
    },

    async replaceAll(entries) {
      const docs = entries.flatMap((entry) => toSearchDoc(entry, settlementCurrency) ?? []);
      await attempt("reconcile", { mode: "reconcile", documents: docs.length }, () => index.replaceAll(docs));
    },
  };
};
