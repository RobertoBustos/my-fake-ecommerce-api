import type { CatalogEntry, SearchPriceState } from "../db/catalogIndex.js";
import { convertPrice } from "../pricing/convert.js";
import { ExchangeRateUnavailableError, getUsableRate } from "../pricing/quote.js";
import type { PricingSettings } from "../pricing/settings.js";
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
//
// Prices: the search index filters and sorts every product by one price, in
// the settlement currency, converted with convertPrice at the rate the sale
// would use (getUsableRate). Without a usable rate a product is indexed
// without a price. What is shown and charged still comes from the catalog
// index and the source.

// The rates of one sync run, each read once: the settlement currency itself
// is 1, and a currency without a usable rate (missing or older than
// maxRateAgeHours) is null.
export interface SearchPricer {
  readonly settlementCurrency: string;
  rateFor(currency: string): Promise<number | null>;
  // Every other currency asked for in this run, with its rate.
  readonly used: Map<string, number | null>;
}

export const createSearchPricer = ({ settlementCurrency, maxRateAgeHours }: PricingSettings): SearchPricer => {
  const loaded = new Map<string, Promise<number | null>>();
  const used = new Map<string, number | null>();
  const load = async (currency: string) => {
    try {
      return (await getUsableRate(currency, settlementCurrency, maxRateAgeHours)).rate;
    } catch (err) {
      if (err instanceof ExchangeRateUnavailableError) return null;
      // Anything else (Firestore down) is retried by the next call.
      loaded.delete(currency);
      throw err;
    }
  };
  return {
    settlementCurrency,
    used,
    async rateFor(currency) {
      if (currency === settlementCurrency) return 1;
      if (!loaded.has(currency)) loaded.set(currency, load(currency));
      const rate = await loaded.get(currency)!;
      used.set(currency, rate);
      return rate;
    },
  };
};

export const toSearchDoc = (entry: CatalogEntry, rate: number | null): SearchDoc => ({
  id: entry.id,
  sourceKey: entry.sourceKey,
  title: entry.title,
  description: entry.description,
  category: entry.category,
  settlementPrice: rate === null ? null : convertPrice(entry.unitPrice, rate),
  inStock: entry.available > 0,
});

// What changed since the search index was last priced: "all" when the
// settlement currency did (or nothing is known yet), otherwise the
// currencies whose rate moved, appeared or stopped being usable.
export const detectPriceChanges = async (
  pricer: SearchPricer,
  state: SearchPriceState | null
): Promise<"all" | string[]> => {
  if (!state || state.settlementCurrency !== pricer.settlementCurrency) return "all";
  const changed: string[] = [];
  for (const [currency, rate] of Object.entries(state.rates)) {
    if ((await pricer.rateFor(currency)) !== rate) changed.push(currency);
  }
  return changed;
};

export interface SearchFeed {
  readonly pricer: SearchPricer;
  // Writes one page of the sync: the entries it wrote and the ids it deleted
  // from the catalog index.
  apply(sourceKey: string, entries: CatalogEntry[], deletedIds: string[]): Promise<void>;
  // Replaces the search index with these entries: every entry of the
  // catalog index, of every source.
  replaceAll(entries: CatalogEntry[]): Promise<void>;
  // Rewrites the documents of these entries, all priced in one currency
  // whose rate changed.
  reprice(currency: string, entries: CatalogEntry[]): Promise<void>;
  // What failed in this run: a source key, "reconcile" for replaceAll or
  // "prices:<currency>" for reprice.
  readonly failed: string[];
}

export const createSearchFeed = (index: SearchIndex, pricer: SearchPricer): SearchFeed => {
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
  const toDocs = (entries: CatalogEntry[]) =>
    Promise.all(entries.map(async (entry) => toSearchDoc(entry, await pricer.rateFor(entry.currency))));

  return {
    pricer,
    failed,

    async apply(sourceKey, entries, deletedIds) {
      await attempt(sourceKey, { sourceKey }, async () => {
        await index.upsert(await toDocs(entries));
        await index.delete(deletedIds);
      });
    },

    async replaceAll(entries) {
      await attempt("reconcile", { mode: "reconcile", documents: entries.length }, async () =>
        index.replaceAll(await toDocs(entries))
      );
    },

    async reprice(currency, entries) {
      await attempt(`prices:${currency}`, { mode: "reprice", currency, documents: entries.length }, async () =>
        index.upsert(await toDocs(entries))
      );
    },
  };
};
