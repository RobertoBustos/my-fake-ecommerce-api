import { afterEach, describe, expect, it } from "vitest";
import {
  AlgoliaConfigError,
  algoliaConfigFromEnv,
  createAlgoliaSearchIndex,
  toAlgoliaFilters,
} from "../src/search/adapters/algolia/index.js";
import { indexSettings } from "../src/search/adapters/algolia/settings.js";

// What the Algolia adapter decides without calling Algolia. Its behaviour
// against a real index is the search contract (npm run test:search:algolia).

const VARS = ["ALGOLIA_APP_ID", "ALGOLIA_INDEX", "ALGOLIA_SEARCH_KEY", "ALGOLIA_INDEXER_KEY"];
const original = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of VARS) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});

const setEnv = (values) => {
  for (const name of VARS) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
};

describe("Algolia adapter configuration", () => {
  it("reads the app id, index and keys from the environment", () => {
    setEnv({ ALGOLIA_APP_ID: "APP", ALGOLIA_INDEX: "ecomapi_dev_catalog", ALGOLIA_SEARCH_KEY: "s" });
    expect(algoliaConfigFromEnv()).toEqual({ appId: "APP", indexName: "ecomapi_dev_catalog", searchKey: "s" });
  });

  it("names every missing variable", () => {
    setEnv({ ALGOLIA_APP_ID: "APP" });
    expect(() => algoliaConfigFromEnv()).toThrow(AlgoliaConfigError);
    expect(() => algoliaConfigFromEnv()).toThrow(/ALGOLIA_INDEX, ALGOLIA_SEARCH_KEY or ALGOLIA_INDEXER_KEY/);
  });

  it("can search but not write with only the search key", async () => {
    const index = createAlgoliaSearchIndex({ appId: "APP", indexName: "ecomapi_dev_catalog", searchKey: "s" });
    await expect(index.upsert([{ id: "x" }])).rejects.toThrow(/ALGOLIA_INDEXER_KEY/);
    await expect(index.replaceAll([])).rejects.toThrow(AlgoliaConfigError);
  });
});

describe("Algolia filters", () => {
  it("joins every filter with AND, sources with OR", () => {
    expect(
      toAlgoliaFilters({ category: "electronics", minPrice: 100, maxPrice: 900, inStock: true, sourceKeys: ["fs", "pg"] }),
    ).toBe(
      'category:"electronics" AND settlementPrice >= 100 AND settlementPrice <= 900 AND inStock:true AND (sourceKey:"fs" OR sourceKey:"pg")',
    );
  });

  it("escapes quotes and backslashes in values", () => {
    expect(toAlgoliaFilters({ category: 'say "hi" \\ bye' })).toBe('category:"say \\"hi\\" \\\\ bye"');
  });

  it("is empty with no filters and null when no source is allowed", () => {
    expect(toAlgoliaFilters()).toBe("");
    expect(toAlgoliaFilters({ sourceKeys: [] })).toBeNull();
  });

  it("answers an empty list of sources without calling Algolia", async () => {
    const index = createAlgoliaSearchIndex({ appId: "APP", indexName: "ecomapi_dev_catalog", searchKey: "s" });
    await expect(index.search({ text: "x", filters: { sourceKeys: [] }, facets: ["category"] })).resolves.toEqual({
      ids: [],
      total: 0,
      facets: [{ name: "category", values: [] }],
    });
  });
});

describe("Algolia index settings", () => {
  it("configures the primary first, with a replica per price order", () => {
    const steps = indexSettings("ecomapi_dev_catalog");
    expect(steps.map((s) => s.indexName)).toEqual([
      "ecomapi_dev_catalog",
      "ecomapi_dev_catalog_price_asc",
      "ecomapi_dev_catalog_price_desc",
    ]);
    expect(steps[0].settings.replicas).toEqual(steps.slice(1).map((s) => s.indexName));
    expect(steps[1].settings.ranking[0]).toBe("asc(settlementPrice)");
    expect(steps[2].settings.ranking[0]).toBe("desc(settlementPrice)");
    // Every index searches the same way; only the first ranking criterion differs.
    for (const { settings } of steps) {
      expect(settings.searchableAttributes).toEqual(["title", "category", "unordered(description)"]);
    }
  });
});
