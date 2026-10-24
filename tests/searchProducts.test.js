import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";
import { createLoaders } from "../src/dataloaders/index.js";
import { toGlobalProductId } from "../src/catalog/productId.js";
import { toSearchDoc } from "../src/catalog/searchFeed.js";
import { deleteCatalogEntries, upsertCatalogEntries } from "../src/db/catalogIndex.js";
import { getSearchIndex } from "../src/search/registry.js";
import { SearchUnavailableError } from "../src/search/ports.js";
import { encodeCursor } from "../src/utils/pagination.js";
import { logger } from "../src/utils/logger.js";

const server = new ApolloServer({ typeDefs, resolvers });
const run = async (query, variables) => {
  const response = await server.executeOperation(
    { query, variables },
    { contextValue: { user: { uid: "user-search" }, loaders: createLoaders() } }
  );
  return response.body.singleResult;
};
const errorOf = (result) => result.errors?.[0]?.extensions;

const SEARCH = `query (
  $query: String!, $category: String, $minPrice: Int, $maxPrice: Int, $inStock: Boolean,
  $sort: ProductSort, $first: Int, $after: String
) {
  searchProducts(
    query: $query, category: $category, minPrice: $minPrice, maxPrice: $maxPrice,
    inStock: $inStock, sort: $sort, first: $first, after: $after
  ) {
    edges { node { id title } cursor }
    pageInfo { hasNextPage endCursor }
    totalCount
    facets { name values { value count } }
  }
}`;

const search = async (variables) => {
  const result = await run(SEARCH, variables);
  expect(result.errors).toBeUndefined();
  return result.data.searchProducts;
};
const titles = (connection) => connection.edges.map(({ node }) => node.title);

describe("searchProducts query (ECOMAPI-95)", () => {
  const run_ = randomUUID().slice(0, 8);
  const entry = (name, { sourceKey = "fs", category = "electronics", price = 1000, available = 3, description = "" } = {}) => {
    const localId = `search-${run_}-${name}`;
    return {
      entry: {
        id: toGlobalProductId(sourceKey, localId),
        sourceKey,
        localId,
        title: `Quokka ${name}`,
        description,
        category,
        image: "",
        currency: "MXN",
        unitPrice: price ?? 1000,
        purchaseLimits: { min: 1, max: 5 },
        available,
        sourceUpdatedAt: null,
        syncedAt: new Date(),
      },
      // null: no usable exchange rate, so the search index has no price.
      rate: price === null ? null : 1,
    };
  };

  // In insertion order, which the in-memory index uses to break ties.
  const fixtures = [
    entry("wireless headphones", { price: 5000 }),
    entry("cable", { price: 1500, description: "For wireless headphones" }),
    // In the search index but no longer in the catalog index.
    entry("ghost", { price: 3000 }),
    entry("ring", { category: "jewelery", price: 9000, available: 0 }),
    entry("shirt", { category: "men's clothing", price: 2500 }),
    entry("globe", { price: null }),
    // Of a source that isn't switched on.
    entry("offline", { sourceKey: `off-${run_}` }),
  ];
  const inCatalog = fixtures.filter(({ entry }) => !entry.title.endsWith("ghost")).map(({ entry }) => entry);
  const originalEngine = process.env.SEARCH_ENGINE;
  const originalSources = process.env.CATALOG_SOURCES;

  beforeAll(async () => {
    process.env.SEARCH_ENGINE = "memory";
    await upsertCatalogEntries(inCatalog);
    await getSearchIndex().replaceAll(fixtures.map(({ entry, rate }) => toSearchDoc(entry, rate)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalSources === undefined) delete process.env.CATALOG_SOURCES;
    else process.env.CATALOG_SOURCES = originalSources;
  });

  afterAll(async () => {
    await deleteCatalogEntries(inCatalog.map(({ id }) => id));
    if (originalEngine === undefined) delete process.env.SEARCH_ENGINE;
    else process.env.SEARCH_ENGINE = originalEngine;
  });

  it("ranks a title match above a description match", async () => {
    const result = await search({ query: "wireless headphones" });
    expect(titles(result)).toEqual(["Quokka wireless headphones", "Quokka cable"]);
  });

  it("tolerates typos and takes the last word as a prefix", async () => {
    expect(titles(await search({ query: "headphnes" }))).toEqual(["Quokka wireless headphones", "Quokka cable"]);
    expect(titles(await search({ query: "quokka shi" }))).toEqual(["Quokka shirt"]);
  });

  it("returns catalog products with their fields resolved", async () => {
    const result = await run(
      `query { searchProducts(query: "quokka shirt") { edges { node { id category stock unitPrice currency source } } } }`
    );
    expect(result.errors).toBeUndefined();
    const [{ node }] = result.data.searchProducts.edges;
    expect(node).toMatchObject({ category: "men's clothing", stock: 3, source: "Main catalog" });
    expect(node.unitPrice).toEqual(expect.any(Number));
    expect(node.currency).toMatch(/^[A-Z]{3}$/);
  });

  it("filters by category, price range and stock", async () => {
    expect(titles(await search({ query: "quokka", category: "jewelery" }))).toEqual(["Quokka ring"]);
    expect(titles(await search({ query: "quokka", inStock: false }))).toEqual(["Quokka ring"]);

    const priced = await search({ query: "quokka", minPrice: 2000, maxPrice: 6000 });
    expect(titles(priced)).toEqual(["Quokka wireless headphones", "Quokka shirt"]);
    // The ghost still counts: the search index is a little behind the catalog.
    expect(priced.totalCount).toBe(3);
  });

  it("sorts by price both ways, with unpriced products last", async () => {
    expect(titles(await search({ query: "quokka", sort: "PRICE_ASC" }))).toEqual([
      "Quokka cable",
      "Quokka shirt",
      "Quokka wireless headphones",
      "Quokka ring",
      "Quokka globe",
    ]);
    expect(titles(await search({ query: "quokka", sort: "PRICE_DESC" }))).toEqual([
      "Quokka ring",
      "Quokka wireless headphones",
      "Quokka shirt",
      "Quokka cable",
      "Quokka globe",
    ]);
  });

  it("counts categories over every match of the search", async () => {
    const result = await search({ query: "quokka", first: 1 });
    expect(result.totalCount).toBe(6);
    expect(result.facets).toEqual([
      {
        name: "category",
        values: [
          { value: "electronics", count: 4 },
          { value: "jewelery", count: 1 },
          { value: "men's clothing", count: 1 },
        ],
      },
    ]);
  });

  it("pages without repeating or skipping products, past ids the catalog no longer has", async () => {
    const pages = [];
    let after = null;
    do {
      const page = await search({ query: "quokka", first: 2, after });
      pages.push(titles(page));
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    expect(pages).toEqual([
      ["Quokka wireless headphones", "Quokka cable"],
      // The ghost was the first of this page.
      ["Quokka ring"],
      ["Quokka shirt", "Quokka globe"],
    ]);
  });

  it("resumes from any edge's cursor", async () => {
    const first = await search({ query: "quokka", first: 2 });
    const next = await search({ query: "quokka", first: 1, after: first.edges[0].cursor });
    expect(titles(next)).toEqual(["Quokka cable"]);
  });

  it("only finds products of switched-on sources", async () => {
    expect(titles(await search({ query: "quokka offline" }))).toEqual([]);

    process.env.CATALOG_SOURCES = "nothing-known";
    const result = await search({ query: "quokka" });
    expect(result).toMatchObject({ edges: [], totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } });
  });

  it.each([
    [{ query: "q" }, "query"],
    [{ query: " q  " }, "query"],
    [{ query: "q".repeat(101) }, "query"],
    [{ query: "quokka", first: 0 }, "first"],
    [{ query: "quokka", first: 51 }, "first"],
    [{ query: "quokka", minPrice: -1 }, "minPrice"],
    [{ query: "quokka", minPrice: 3000, maxPrice: 2000 }, "minPrice"],
  ])("rejects %j with BAD_USER_INPUT naming %s", async (variables, invalidArgument) => {
    expect(errorOf(await run(SEARCH, variables))).toMatchObject({ code: "BAD_USER_INPUT", invalidArgument });
  });

  it("rejects a cursor that isn't from a search", async () => {
    const products = await run(`query { products(first: 1) { pageInfo { endCursor } } }`);
    for (const after of ["nope", products.data.products.pageInfo.endCursor, encodeCursor("search:-1")]) {
      expect(errorOf(await run(SEARCH, { query: "quokka", after }))).toMatchObject({
        code: "BAD_USER_INPUT",
        invalidArgument: "after",
      });
    }
  });

  it("answers SERVICE_UNAVAILABLE with retryable while the search engine is down", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(getSearchIndex(), "search").mockRejectedValue(new SearchUnavailableError("memory", new Error("timeout")));
    const result = await run(SEARCH, { query: "quokka" });
    expect(errorOf(result)).toEqual({ code: "SERVICE_UNAVAILABLE", retryable: true });
    expect(logger.warn).toHaveBeenCalledWith(
      "Search engine call failed",
      expect.objectContaining({ engine: "memory", cause: "timeout" })
    );
  });
});
