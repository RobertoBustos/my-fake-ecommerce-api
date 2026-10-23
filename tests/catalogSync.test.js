import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import db from "../src/config/firestore.js";
import {
  applyCatalogChanges,
  pullCatalogSource,
  reconcileCatalogSource,
  syncCatalog,
} from "../src/catalog/catalogSync.js";
import { toGlobalProductId } from "../src/catalog/productId.js";
import { firestoreCatalogSource } from "../src/catalog/sources/firestore/adapter.js";
import { createSearchFeed, createSearchPricer } from "../src/catalog/searchFeed.js";
import {
  getCatalogEntry,
  getCatalogSyncState,
  listAllCatalogEntries,
  listCatalogEntryIds,
  saveSearchPriceState,
  upsertCatalogEntries,
} from "../src/db/catalogIndex.js";
import { writeExchangeRates } from "../src/db/pricing.js";
import { createMemorySearchIndex } from "../src/search/adapters/memory.js";
import { SearchUnavailableError } from "../src/search/ports.js";
import { getConfiguredSearchIndex } from "../src/search/registry.js";
import { logger } from "../src/utils/logger.js";
import { createMemorySource, seedMemorySource } from "./contract/memorySource.js";

const keys = [];
const newSource = (options = {}) => {
  const key = `sync-${randomUUID().slice(0, 8)}`;
  keys.push(key);
  return createMemorySource({ key, ...options });
};
const at = (iso) => new Date(`2026-10-${iso}Z`);
const entryOf = (source, localId) => getCatalogEntry(toGlobalProductId(source.key, localId));

// The Firestore source's entries stay: the products query of later test
// files reads them. Only this file's own fixtures are removed.
afterAll(async () => {
  for (const key of keys) {
    const ids = await listCatalogEntryIds(key);
    await Promise.all(ids.map((id) => db.collection("catalog").doc(id).delete()));
    await db.collection("catalogSync").doc(key).delete();
  }
  await db.collection("catalogSync").doc("fs").delete();
});

describe("catalog sync: pull (ECOMAPI-77)", () => {
  it("adds new products to the index with their copy and source", async () => {
    const source = newSource();
    seedMemorySource(source, [
      { localId: "a", category: "jewelery", available: 4, updatedAt: at("01T10:00:00") },
      { localId: "b", category: "electronics", available: 2, updatedAt: at("02T10:00:00") },
    ]);
    const now = at("03T00:00:00");
    const result = await pullCatalogSource(source, { now });
    expect(result).toMatchObject({ mode: "pull", upserted: 2, deleted: 0, resumed: false });

    expect(await entryOf(source, "a")).toEqual({
      id: toGlobalProductId(source.key, "a"),
      sourceKey: source.key,
      localId: "a",
      title: "Product a",
      description: "",
      category: "jewelery",
      image: "",
      currency: "MXN",
      unitPrice: 1500,
      purchaseLimits: { min: 1, max: 10 },
      available: 4,
      sourceUpdatedAt: at("01T10:00:00"),
      syncedAt: now,
    });
    const state = await getCatalogSyncState(source.key);
    expect(state).toMatchObject({ since: at("02T10:00:00"), cursor: null, lastSyncedAt: now });
  });

  it("only rewrites what changed since the last run", async () => {
    const source = newSource();
    seedMemorySource(source, [
      { localId: "a", category: "electronics", available: 4, updatedAt: at("01T10:00:00") },
      { localId: "b", category: "electronics", available: 2, updatedAt: at("01T11:00:00") },
    ]);
    await pullCatalogSource(source, { now: at("02T00:00:00") });

    source.products.get("b").stock = 9;
    source.products.get("b").updatedAt = at("02T12:00:00");
    const result = await pullCatalogSource(source, { now: at("03T00:00:00") });

    expect(result.upserted).toBe(1);
    expect(await entryOf(source, "b")).toMatchObject({ available: 9, syncedAt: at("03T00:00:00") });
    expect((await entryOf(source, "a")).syncedAt).toEqual(at("02T00:00:00"));
    expect((await getCatalogSyncState(source.key)).since).toEqual(at("02T12:00:00"));
  });

  it("deletes the products the source reports as deleted", async () => {
    const source = newSource();
    seedMemorySource(source, [{ localId: "a", category: "electronics", available: 1 }]);
    await pullCatalogSource(source);
    await applyCatalogChanges(source.key, { items: [], deletedIds: ["a"] });
    expect(await entryOf(source, "a")).toBeNull();
  });

  it("resumes from the saved cursor after a run that stopped halfway", async () => {
    const source = newSource();
    seedMemorySource(
      source,
      Array.from({ length: 150 }, (_, i) => ({
        localId: `p${String(i).padStart(3, "0")}`,
        category: "electronics",
        available: 1,
        updatedAt: new Date(at("01T00:00:00").getTime() + i * 1000),
      }))
    );
    const listChanged = source.listChanged;
    let calls = 0;
    source.listChanged = async (since, page) => {
      calls += 1;
      if (calls === 2) throw new Error("source went away");
      return listChanged(since, page);
    };
    await expect(pullCatalogSource(source)).rejects.toThrow("source went away");
    const stopped = await getCatalogSyncState(source.key);
    expect(stopped.cursor).toBe("p099");
    expect(await entryOf(source, "p099")).not.toBeNull();
    expect(await entryOf(source, "p100")).toBeNull();

    const result = await pullCatalogSource(source);
    expect(result).toMatchObject({ resumed: true, upserted: 50 });
    const state = await getCatalogSyncState(source.key);
    expect(state.cursor).toBeNull();
    expect(state.since).toEqual(new Date(at("01T00:00:00").getTime() + 149 * 1000));
    expect((await listCatalogEntryIds(source.key)).length).toBe(150);
  });

  it("lists everything on every run when the source doesn't track changes", async () => {
    const source = newSource({ tracksChanges: false });
    seedMemorySource(source, [{ localId: "a", category: "electronics", available: 1 }]);
    await pullCatalogSource(source);
    expect((await getCatalogSyncState(source.key)).since).toBeNull();
    expect((await pullCatalogSource(source)).upserted).toBe(1);
  });
});

describe("catalog sync: reconciliation (ECOMAPI-77)", () => {
  it("deletes from the index what the source no longer has, and only for that source", async () => {
    const source = newSource();
    const other = newSource();
    seedMemorySource(source, [
      { localId: "keep", category: "electronics", available: 1 },
      { localId: "gone", category: "electronics", available: 1 },
    ]);
    seedMemorySource(other, [{ localId: "gone", category: "electronics", available: 1 }]);
    await pullCatalogSource(source);
    await pullCatalogSource(other);

    source.products.delete("gone");
    // A pull can't see a deletion the source doesn't report.
    await pullCatalogSource(source);
    expect(await entryOf(source, "gone")).not.toBeNull();

    const now = at("05T00:00:00");
    const result = await reconcileCatalogSource(source, { now });
    expect(result).toMatchObject({ mode: "reconcile", upserted: 1, deleted: 1 });
    expect(await entryOf(source, "gone")).toBeNull();
    expect(await entryOf(source, "keep")).not.toBeNull();
    expect(await entryOf(other, "gone")).not.toBeNull();
    expect((await getCatalogSyncState(source.key)).lastReconciledAt).toEqual(now);
  });
});

describe("catalog sync job over the registry (ECOMAPI-77)", () => {
  const original = process.env.CATALOG_SOURCES;
  const productIds = [];
  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.CATALOG_SOURCES;
    else process.env.CATALOG_SOURCES = original;
  });
  afterAll(async () => {
    await Promise.all(productIds.map((id) => db.collection("products").doc(id).delete()));
    await Promise.all(
      productIds.map((id) => db.collection("catalog").doc(toGlobalProductId("fs", id)).delete())
    );
  });

  const newProduct = async (stock) => {
    const id = `test-sync-${randomUUID()}`;
    productIds.push(id);
    await db.collection("products").doc(id).set({
      title: "Sync fixture",
      description: "A product to sync",
      category: "electronics",
      image: "https://example.com/p.png",
      currency: "MXN",
      unitPrice: 2500,
      purchaseLimits: { min: 1, max: 5 },
      stock,
      updatedAt: new Date(),
    });
    return id;
  };

  it("reconciles the Firestore source first, then pulls its changes, and reconciles again when due", async () => {
    delete process.env.CATALOG_SOURCES;
    await db.collection("catalogSync").doc("fs").delete();
    const id = await newProduct(6);
    const start = new Date();

    const first = await syncCatalog({ now: start });
    expect(first.failed).toEqual([]);
    expect(first.synced).toEqual([expect.objectContaining({ sourceKey: "fs", mode: "reconcile" })]);
    expect(await getCatalogEntry(toGlobalProductId("fs", id))).toMatchObject({
      title: "Sync fixture",
      description: "A product to sync",
      category: "electronics",
      image: "https://example.com/p.png",
      unitPrice: 2500,
      currency: "MXN",
      purchaseLimits: { min: 1, max: 5 },
      available: 6,
    });

    // A reservation changes the stock and its updatedAt, so the next pull sees it.
    await firestoreCatalogSource.reserve(id, 2, `test-sync-${randomUUID()}-reserve`);
    const second = await syncCatalog({ now: new Date(start.getTime() + 60_000) });
    expect(second.synced[0]).toMatchObject({ mode: "pull" });
    expect(second.synced[0].upserted).toBeGreaterThanOrEqual(1);
    expect((await getCatalogEntry(toGlobalProductId("fs", id))).available).toBe(4);

    await db.collection("products").doc(id).delete();
    const due = await syncCatalog({ now: new Date(start.getTime() + 25 * 3_600_000) });
    expect(due.synced[0]).toMatchObject({ mode: "reconcile" });
    expect(await getCatalogEntry(toGlobalProductId("fs", id))).toBeNull();
  });

  it("reconciles on request", async () => {
    delete process.env.CATALOG_SOURCES;
    const { synced } = await syncCatalog({ reconcile: true });
    expect(synced[0]).toMatchObject({ sourceKey: "fs", mode: "reconcile" });
  });

  it("doesn't sync a source that is switched off", async () => {
    process.env.CATALOG_SOURCES = "other";
    await db.collection("catalogSync").doc("fs").delete();
    const { synced, failed } = await syncCatalog();
    expect(synced).toEqual([]);
    expect(failed).toEqual([]);
    expect(await getCatalogSyncState("fs")).toBeNull();
    await expect(syncCatalog({ sourceKeys: ["fs"] })).rejects.toThrow("not switched on: fs");
  });

  it("logs a source that fails and reports it", async () => {
    delete process.env.CATALOG_SOURCES;
    vi.spyOn(firestoreCatalogSource, "listChanged").mockRejectedValue(new Error("source is down"));
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { synced, failed } = await syncCatalog();
    expect(synced).toEqual([]);
    expect(failed).toEqual([{ sourceKey: "fs", error: "source is down" }]);
    expect(error).toHaveBeenCalledWith("Catalog sync failed", { sourceKey: "fs", error: "source is down" });
  });
});

const pricing = (settlementCurrency = "MXN") => ({ settlementCurrency, rateProvider: "banxico", maxRateAgeHours: 24 });
const feedFor = (index, settlementCurrency = "MXN") => createSearchFeed(index, createSearchPricer(pricing(settlementCurrency)));

describe("catalog sync: search index (ECOMAPI-93)", () => {
  afterEach(() => vi.restoreAllMocks());

  const everything = (index, sourceKeys) =>
    index.search({ text: "", filters: sourceKeys ? { sourceKeys } : {}, page: { offset: 0, limit: 1000 } });

  it("writes each pulled page to the search index after the catalog index", async () => {
    const source = newSource();
    seedMemorySource(source, [
      { localId: "a", category: "jewelery", available: 4 },
      { localId: "b", category: "electronics", available: 0 },
    ]);
    const index = createMemorySearchIndex();
    await pullCatalogSource(source, { search: feedFor(index) });

    const id = toGlobalProductId(source.key, "a");
    expect(new Set((await everything(index, [source.key])).ids)).toEqual(
      new Set([id, toGlobalProductId(source.key, "b")])
    );
    const result = await index.search({ text: "product a", filters: { sourceKeys: [source.key] } });
    expect(result.ids).toEqual([id]);
    expect((await index.search({ text: "", filters: { sourceKeys: [source.key], inStock: false } })).ids).toEqual([
      toGlobalProductId(source.key, "b"),
    ]);
    expect((await index.search({ text: "", filters: { sourceKeys: [source.key], minPrice: 1500, maxPrice: 1500 } })).total).toBe(2);
  });

  it("removes deleted products from the search index", async () => {
    const source = newSource();
    seedMemorySource(source, [{ localId: "a", category: "electronics", available: 1 }]);
    const index = createMemorySearchIndex();
    const search = feedFor(index);
    await pullCatalogSource(source, { search });
    await applyCatalogChanges(source.key, { items: [], deletedIds: ["a"] }, new Date(), search);
    expect((await everything(index, [source.key])).ids).toEqual([]);
  });


  it("makes the search index a copy of the whole catalog index after a reconciliation", async () => {
    delete process.env.CATALOG_SOURCES;
    const index = createMemorySearchIndex();
    // A document the catalog index doesn't have, as left by a failed delete.
    await index.upsert([
      { id: "stale", sourceKey: "fs", title: "Stale", description: "", category: "electronics", settlementPrice: 1, inStock: true },
    ]);
    const { synced, searchFailed } = await syncCatalog({ reconcile: true, searchIndex: index });
    expect(synced[0]).toMatchObject({ sourceKey: "fs", mode: "reconcile" });
    expect(searchFailed).toEqual([]);

    const catalog = (await listAllCatalogEntries()).filter((entry) => entry.currency === "MXN");
    const searched = await everything(index);
    expect(searched.total).toBe(catalog.length);
    expect(new Set(searched.ids)).toEqual(new Set(catalog.map((entry) => entry.id)));
  });

  it("only pulls into the search index when no source is due for reconciliation", async () => {
    delete process.env.CATALOG_SOURCES;
    await syncCatalog({ reconcile: true, searchIndex: null });
    await saveSearchPriceState({ settlementCurrency: "MXN", rates: {} });
    const index = createMemorySearchIndex();
    const replaceAll = vi.spyOn(index, "replaceAll");
    const { synced } = await syncCatalog({ searchIndex: index, pricing: pricing() });
    expect(synced[0]).toMatchObject({ mode: "pull" });
    expect(replaceAll).not.toHaveBeenCalled();
  });

  it("keeps syncing the catalog when the search engine is down, and logs a warning", async () => {
    const source = newSource();
    seedMemorySource(source, [{ localId: "a", category: "electronics", available: 1, updatedAt: at("01T10:00:00") }]);
    const down = new SearchUnavailableError("memory", new Error("engine is down"));
    const index = { ...createMemorySearchIndex(), upsert: async () => Promise.reject(down) };
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const search = feedFor(index);

    const result = await pullCatalogSource(source, { search });
    expect(result.upserted).toBe(1);
    expect(await entryOf(source, "a")).not.toBeNull();
    expect((await getCatalogSyncState(source.key)).since).toEqual(at("01T10:00:00"));
    expect(search.failed).toEqual([source.key]);
    expect(warn).toHaveBeenCalledWith("Search index sync failed", {
      sourceKey: source.key,
      engine: "memory",
      error: "Search engine memory is unavailable",
      cause: "engine is down",
    });
  });

  it("reports a failed reconciliation of the search index without failing the run", async () => {
    delete process.env.CATALOG_SOURCES;
    const index = { ...createMemorySearchIndex(), replaceAll: async () => Promise.reject(new Error("engine is down")) };
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { failed, searchFailed } = await syncCatalog({ reconcile: true, searchIndex: index });
    expect(failed).toEqual([]);
    expect(searchFailed).toEqual(["reconcile"]);
    expect(warn).toHaveBeenCalledWith("Search index sync failed", expect.objectContaining({ mode: "reconcile" }));
  });

  it("doesn't touch a search index while SEARCH_ENGINE is unset", async () => {
    const original = process.env.SEARCH_ENGINE;
    delete process.env.SEARCH_ENGINE;
    try {
      expect(getConfiguredSearchIndex()).toBeNull();
      delete process.env.CATALOG_SOURCES;
      const { failed, searchFailed } = await syncCatalog({ reconcile: true });
      expect(failed).toEqual([]);
      expect(searchFailed).toEqual([]);
    } finally {
      if (original !== undefined) process.env.SEARCH_ENGINE = original;
    }
  });
});

describe("catalog sync: settlement prices in the search index (ECOMAPI-94)", () => {
  // XTS is ISO 4217's code for testing, so no other fixture prices in it.
  const freshRate = (rate, fetchedAt = new Date()) => ({ from: "XTS", to: "MXN", rate, asOf: "2026-10-22", fetchedAt, source: "test" });
  const sourceKey = `prices-${randomUUID().slice(0, 8)}`;
  const entry = (localId, overrides = {}) => ({
    id: toGlobalProductId(sourceKey, localId),
    sourceKey,
    localId,
    title: `Priced ${localId}`,
    description: "",
    category: "electronics",
    image: "",
    currency: "XTS",
    unitPrice: 1000,
    purchaseLimits: { min: 1, max: 5 },
    available: 3,
    sourceUpdatedAt: null,
    syncedAt: new Date(),
    ...overrides,
  });
  // The indexed price as the search index answers it: narrowed down with
  // its inclusive price range filter, null when no range matches.
  const priceOf = async (index, id) => {
    const matches = async (minPrice, maxPrice) =>
      (await index.search({ text: "", filters: { sourceKeys: [sourceKey], minPrice, maxPrice }, page: { offset: 0, limit: 100 } })).ids.includes(id);
    let low = 0;
    let high = 10_000_000;
    if (!(await matches(low, high))) return null;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (await matches(low, mid)) high = mid;
      else low = mid + 1;
    }
    return low;
  };

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    const ids = await listCatalogEntryIds(sourceKey);
    await Promise.all(ids.map((id) => db.collection("catalog").doc(id).delete()));
    await db.collection("exchangeRates").doc("XTS_MXN").delete();
    await db.collection("exchangeRates").doc("MXN_XTS").delete();
    await db.collection("searchIndex").doc("prices").delete();
  });

  it("converts a price to the settlement currency at the usable rate", async () => {
    await writeExchangeRates([freshRate(17.5)]);
    const index = createMemorySearchIndex();
    const priced = entry("a", { unitPrice: 1999 });
    await feedFor(index).apply(sourceKey, [priced], []);
    // 1999 × 17.5 = 34982.5, to the even cent.
    expect(await priceOf(index, priced.id)).toBe(34982);
  });

  it("indexes a product without a usable rate without a price: found by text, not by a price filter", async () => {
    await writeExchangeRates([freshRate(17.5, new Date(Date.now() - 48 * 3_600_000))]);
    const index = createMemorySearchIndex();
    const stale = entry("b", { title: "Stale rate lamp" });
    vi.spyOn(logger, "error").mockImplementation(() => {});
    await feedFor(index).apply(sourceKey, [stale], []);
    expect((await index.search({ text: "stale lamp", filters: { sourceKeys: [sourceKey] } })).ids).toEqual([stale.id]);
    expect(await priceOf(index, stale.id)).toBeNull();
  });

  it("reprices only the products of a currency whose rate changed", async () => {
    delete process.env.CATALOG_SOURCES;
    await writeExchangeRates([freshRate(10)]);
    const index = createMemorySearchIndex();
    const usd = entry("c");
    await upsertCatalogEntries([usd]);
    await syncCatalog({ reconcile: true, searchIndex: index, pricing: pricing() });
    expect(await priceOf(index, usd.id)).toBe(10_000);

    await writeExchangeRates([freshRate(20)]);
    const upsert = vi.spyOn(index, "upsert");
    const replaceAll = vi.spyOn(index, "replaceAll");
    const { synced, searchFailed } = await syncCatalog({ searchIndex: index, pricing: pricing() });
    expect(synced[0]).toMatchObject({ mode: "pull" });
    expect(searchFailed).toEqual([]);
    expect(replaceAll).not.toHaveBeenCalled();
    const repriced = upsert.mock.calls.flatMap(([docs]) => docs).filter((doc) => doc.settlementPrice !== null);
    expect(repriced.some((doc) => doc.id === usd.id)).toBe(true);
    expect(repriced.every((doc) => doc.sourceKey === sourceKey)).toBe(true);
    expect(await priceOf(index, usd.id)).toBe(20_000);

    // Nothing changed since: the next run doesn't reprice again.
    upsert.mockClear();
    await syncCatalog({ searchIndex: index, pricing: pricing() });
    expect(upsert.mock.calls.flatMap(([docs]) => docs).some((doc) => doc.id === usd.id)).toBe(false);
  });

  it("reprices everything when the settlement currency changes", async () => {
    delete process.env.CATALOG_SOURCES;
    await writeExchangeRates([freshRate(10)]);
    const index = createMemorySearchIndex();
    const xts = entry("d", { unitPrice: 700 });
    const mxn = entry("e", { currency: "MXN", unitPrice: 5000 });
    await upsertCatalogEntries([xts, mxn]);
    await syncCatalog({ reconcile: true, searchIndex: index, pricing: pricing() });
    expect([await priceOf(index, xts.id), await priceOf(index, mxn.id)]).toEqual([7000, 5000]);

    // Settled in XTS now, with a rate for MXN.
    await writeExchangeRates([{ ...freshRate(0.1), from: "MXN", to: "XTS" }]);
    const replaceAll = vi.spyOn(index, "replaceAll");
    const { synced } = await syncCatalog({ searchIndex: index, pricing: pricing("XTS") });
    expect(synced[0]).toMatchObject({ mode: "pull" });
    expect(replaceAll).toHaveBeenCalledTimes(1);
    expect([await priceOf(index, xts.id), await priceOf(index, mxn.id)]).toEqual([700, 500]);
  });

  it("keeps the recorded prices when repricing fails, so the next run tries again", async () => {
    delete process.env.CATALOG_SOURCES;
    await writeExchangeRates([freshRate(10)]);
    const index = createMemorySearchIndex();
    await upsertCatalogEntries([entry("f")]);
    await syncCatalog({ reconcile: true, searchIndex: index, pricing: pricing() });

    await writeExchangeRates([freshRate(30)]);
    const broken = { ...index, upsert: async () => Promise.reject(new Error("engine is down")) };
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect((await syncCatalog({ searchIndex: broken, pricing: pricing() })).searchFailed).toContain("prices:XTS");

    const upsert = vi.spyOn(index, "upsert");
    expect((await syncCatalog({ searchIndex: index, pricing: pricing() })).searchFailed).toEqual([]);
    expect(upsert.mock.calls.flatMap(([docs]) => docs).some((doc) => doc.id === entry("f").id)).toBe(true);
  });
});
