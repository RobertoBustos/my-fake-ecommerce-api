import { describe, it, expect } from "vitest";
import type { PageInfo, Product } from "../src/generated/graphql.js";
import { requireEnv } from "./helpers/env.js";
import { dataOf, errorCodeOf, gql } from "./helpers/graphql.js";

type ProductNode = Pick<Product, "id" | "title" | "stock" | "unitPrice" | "currency" | "source">;
interface ProductsData {
  products: { edges: { node: ProductNode }[]; pageInfo: PageInfo };
}

const PRODUCTS = `query Products($id: ID, $first: Int, $after: String) {
  products(id: $id, first: $first, after: $after) {
    edges { node { id title stock unitPrice currency source } }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Global product ids are "<source>:<localId>" in base64url; the API's own
// parser lives in src/catalog/productId.ts. Built here by hand so the suite
// only talks to the deployed API.
const decodeId = (id: string) => Buffer.from(id, "base64url").toString("utf8");
const encodeId = (sourceKey: string, localId: string) => Buffer.from(`${sourceKey}:${localId}`).toString("base64url");

const PAGE_SIZE = 5;
// A guard against a cursor that never ends, far above the demo catalog.
const MAX_PAGES = 100;

describe("catalog in the deployed API", () => {
  const productId = requireEnv("E2E_PRODUCT_ID");

  it("pages through the whole catalog without repeats and finds the e2e product", async () => {
    const ids: string[] = [];
    let after: string | null | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { products } = dataOf(await gql<ProductsData>(PRODUCTS, { first: PAGE_SIZE, after }));
      expect(products.edges.length).toBeLessThanOrEqual(PAGE_SIZE);
      ids.push(...products.edges.map(({ node }) => node.id));
      if (!products.pageInfo.hasNextPage) break;
      expect(products.pageInfo.endCursor).toBeTruthy();
      after = products.pageInfo.endCursor;
    }
    expect(ids.length).toBeGreaterThan(PAGE_SIZE);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(productId);
  });

  it("returns the e2e product by its global id, with its source and stock", async () => {
    const { products } = dataOf(await gql<ProductsData>(PRODUCTS, { id: productId }));
    expect(products.edges).toHaveLength(1);
    const product = products.edges[0].node;

    expect(product.id).toBe(productId);
    expect(product.id).not.toContain(":");
    expect(decodeId(product.id)).toMatch(/^[\w-]+:.+/);
    expect(product.source).toEqual(expect.any(String));
    expect(product.source).not.toBe("");
    // Every completed purchase sells one unit; a low stock means it's time
    // to top the e2e product up.
    expect(product.stock).toBeGreaterThan(10);
    expect(product.unitPrice).toBeGreaterThan(0);
    expect(product.currency).toMatch(/^[A-Z]{3}$/);
  });

  it("answers NOT_FOUND for the id of a source the API doesn't have", async () => {
    const result = await gql(PRODUCTS, { id: encodeId("e2e-unknown-source", "1") });
    expect(errorCodeOf(result)).toBe("NOT_FOUND");
  });
});
