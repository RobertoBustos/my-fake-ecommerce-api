import { describe, it, expect } from "vitest";
import type { PageInfo, Product, ProductFacet, ProductSort } from "../src/generated/graphql.js";
import { requireEnv } from "./helpers/env.js";
import { dataOf, gql, type GraphQLResult } from "./helpers/graphql.js";

// searchProducts against the deployed API and its real search index, fed by
// the catalog sync job. It reads only, so it can run any time after the
// index has been filled (see the Runbook).

type SearchNode = Pick<Product, "id" | "title" | "category" | "unitPrice">;
interface SearchData {
  searchProducts: {
    edges: { node: SearchNode; cursor: string }[];
    pageInfo: PageInfo;
    totalCount: number;
    facets: ProductFacet[];
  };
}
interface SearchVariables {
  query: string;
  category?: string;
  sort?: ProductSort;
  first?: number;
  after?: string | null;
}

const SEARCH = `query SearchProducts($query: String!, $category: String, $sort: ProductSort, $first: Int, $after: String) {
  searchProducts(query: $query, category: $category, sort: $sort, first: $first, after: $after) {
    edges { node { id title category unitPrice } cursor }
    pageInfo { hasNextPage endCursor }
    totalCount
    facets { name values { value count } }
  }
}`;

const search = async (variables: SearchVariables) =>
  dataOf(await gql<SearchData>(SEARCH, { ...variables })).searchProducts;
const titles = (result: SearchData["searchProducts"]) => result.edges.map(({ node }) => node.title);

// The demo catalog has a few jackets, in more than one category, which is
// enough to check typos, prefixes, facets and pages with real data.
const JACKET = /jacket/i;
// A guard against a cursor that never ends.
const MAX_PAGES = 50;

describe("product search in the deployed API", () => {
  const productId = requireEnv("E2E_PRODUCT_ID");

  it('finds jackets when the query has a typo ("jaket")', async () => {
    const result = await search({ query: "jaket" });
    expect(result.totalCount).toBeGreaterThan(0);
    expect(titles(result)[0]).toMatch(JACKET);
  });

  it('finds the same jackets from a prefix ("jac")', async () => {
    const typo = await search({ query: "jaket", first: 50 });
    const prefix = await search({ query: "jac", first: 50 });
    const jackets = (result: SearchData["searchProducts"]) =>
      result.edges.filter(({ node }) => JACKET.test(node.title)).map(({ node }) => node.id);
    expect(jackets(prefix).length).toBeGreaterThan(0);
    expect(jackets(prefix).sort()).toEqual(jackets(typo).sort());
  });

  it("finds the e2e product by its title", async () => {
    const { products } = dataOf(
      await gql<{ products: { edges: { node: Pick<Product, "title"> }[] } }>(
        `query Product($id: ID) { products(id: $id) { edges { node { title } } } }`,
        { id: productId }
      )
    );
    const [{ node }] = products.edges;
    // The longest query the API takes.
    const result = await search({ query: node.title.slice(0, 100), first: 10 });
    expect(result.edges.map((edge) => edge.node.id)).toContain(productId);
  });

  it("filters by category with the count its facet promised", async () => {
    const all = await search({ query: "jacket" });
    const [facet] = all.facets;
    expect(facet.name).toBe("category");
    expect(facet.values.length).toBeGreaterThan(0);
    expect(facet.values.reduce((sum, { count }) => sum + count, 0)).toBe(all.totalCount);

    for (const { value, count } of facet.values) {
      const filtered = await search({ query: "jacket", category: value, first: 50 });
      expect(filtered.totalCount).toBe(count);
      expect(filtered.edges.every(({ node }) => node.category === value)).toBe(true);
    }
  });

  it("sorts by price with PRICE_ASC", async () => {
    const result = await search({ query: "jacket", sort: "PRICE_ASC", first: 50 });
    const prices = result.edges.map(({ node }) => node.unitPrice);
    expect(prices.length).toBeGreaterThan(1);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it("pages through a search without repeating products", async () => {
    const ids: string[] = [];
    let after: string | null | undefined;
    let pages = 0;
    let total: number | undefined;
    do {
      const page = await search({ query: "jacket", first: 2, after });
      total = page.totalCount;
      ids.push(...page.edges.map(({ node }) => node.id));
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      pages += 1;
    } while (after && pages < MAX_PAGES);

    expect(pages).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
    // The index can be a little behind the catalog, so a page may leave out
    // a product the catalog no longer has, but never add one.
    expect(ids.length).toBeLessThanOrEqual(total);
  });

  it("answers BAD_USER_INPUT for a one-character query", async () => {
    const result: GraphQLResult<unknown> = await gql(SEARCH, { query: "j" });
    expect(result.errors?.[0]?.extensions).toMatchObject({ code: "BAD_USER_INPUT", invalidArgument: "query" });
  });
});
