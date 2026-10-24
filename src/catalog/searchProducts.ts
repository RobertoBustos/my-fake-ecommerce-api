import { GraphQLError } from "graphql";
import { getSearchIndex } from "../search/registry.js";
import {
  SearchUnavailableError,
  type Facet,
  type SearchQuery,
  type SearchResult,
  type SearchSort,
} from "../search/ports.js";
import type { Product } from "../types/models.js";
import { logger } from "../utils/logger.js";
import { cursorNotInList, decodeCursor, encodeCursor } from "../utils/pagination.js";
import { getIndexedCatalogProducts } from "./index.js";
import { listEnabledSources } from "./registry.js";

// The searchProducts query: the search index finds and orders the ids, and
// the catalog index turns them into products, the same ones the products
// query lists (price converted by the Product field resolvers).
//
// The search index can be a little behind the catalog (the sync runs every
// 15 minutes, and an engine may answer a repeated query from its own cache),
// so an id the catalog no longer holds is left out of the page instead of
// failing it, and totalCount may still count it.

// Engines only page through the first matches (Algolia's default is 1000),
// so a search never asks for a position past this one.
export const MAX_SEARCH_POSITION = 1000;

export interface ProductSearch {
  query: string;
  category?: string | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  inStock?: boolean | null;
  sort?: SearchSort | null;
  first: number;
  after?: string | null;
}

export interface ProductSearchConnection {
  edges: { node: Product; cursor: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount: number;
  facets: Facet[];
}

// A cursor is the base64 of the engine position right after its product,
// so the next page starts there whatever was left out of this one.
const CURSOR_PREFIX = "search:";
const toCursor = (position: number) => encodeCursor(`${CURSOR_PREFIX}${position}`);
const fromCursor = (after: string) => {
  const match = /^search:(\d{1,9})$/.exec(decodeCursor(after));
  if (!match) throw cursorNotInList();
  return Number(match[1]);
};

// The engine is down, failed or took longer than SEARCH_TIMEOUT_MS
// (search/timeout.ts): the client can retry, and nothing else is affected.
const unavailable = () =>
  new GraphQLError("Search is unavailable right now, please try again", {
    extensions: { code: "SERVICE_UNAVAILABLE", retryable: true },
  });

const empty: ProductSearchConnection = {
  edges: [],
  pageInfo: { hasNextPage: false, endCursor: null },
  totalCount: 0,
  facets: [{ name: "category", values: [] }],
};

// run is how a query reaches the engine: the request's search loader, so
// identical searches of one request are made once.
export const searchCatalogProducts = async (
  search: ProductSearch,
  run: (query: SearchQuery) => Promise<SearchResult> = (query) => getSearchIndex().search(query)
): Promise<ProductSearchConnection> => {
  const offset = search.after == null ? 0 : fromCursor(search.after);
  const sourceKeys = listEnabledSources().map((source) => source.key);
  if (sourceKeys.length === 0) return empty;

  const limit = Math.max(0, Math.min(search.first, MAX_SEARCH_POSITION - offset));
  let result;
  try {
    result = await run({
      text: search.query.trim(),
      filters: {
        sourceKeys,
        category: search.category ?? undefined,
        minPrice: search.minPrice ?? undefined,
        maxPrice: search.maxPrice ?? undefined,
        inStock: search.inStock ?? undefined,
      },
      sort: search.sort ?? "RELEVANCE",
      // A page past the last position still asks the engine, for the total
      // and the facets.
      page: { offset: Math.min(offset, MAX_SEARCH_POSITION), limit },
      facets: ["category"],
    });
  } catch (err) {
    if (!(err instanceof SearchUnavailableError)) throw err;
    // Never the query itself: what people search for stays out of the logs.
    // The logger adds the request id.
    const cause = err.cause instanceof Error ? err.cause.message : undefined;
    logger.warn("Search engine call failed", { engine: err.engineKey, error: err.message, cause });
    throw unavailable();
  }

  const ids = result.ids.slice(0, limit);
  const products = await getIndexedCatalogProducts(ids, { askSources: false });
  const edges = ids.flatMap((_, i) => {
    const node = products[i];
    return node ? [{ node, cursor: toCursor(offset + i + 1) }] : [];
  });
  const next = offset + ids.length;
  return {
    edges,
    pageInfo: {
      hasNextPage: ids.length > 0 && next < Math.min(result.total, MAX_SEARCH_POSITION),
      // The end of the engine page, even when its last products were left
      // out (or all of them), so the next page never repeats or skips one.
      endCursor: ids.length > 0 ? toCursor(next) : null,
    },
    totalCount: result.total,
    facets: result.facets,
  };
};
