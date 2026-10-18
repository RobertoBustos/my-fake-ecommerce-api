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
import { getCatalogEntry, getCatalogSyncState, listCatalogEntryIds } from "../src/db/catalogIndex.js";
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

afterAll(async () => {
  for (const key of [...keys, "fs"]) {
    const ids = await listCatalogEntryIds(key);
    await Promise.all(ids.map((id) => db.collection("catalog").doc(id).delete()));
    await db.collection("catalogSync").doc(key).delete();
  }
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
