// The contract every search engine adapter implements (Algolia first;
// Typesense, Meilisearch or Firestore Enterprise later). The rest of the API
// only knows these types: no engine concept (record ids, replicas,
// highlighting, typo settings) leaks past its adapter or into the schema.

export interface SearchDoc {
  // Global product id.
  id: string;
  // So products of a switched-off source can be filtered out.
  sourceKey: string;
  title: string;
  description: string;
  category: string;
  // Cents in the settlement currency of the day it was indexed.
  settlementPrice: number;
  inStock: boolean;
}

export type SearchSort = "RELEVANCE" | "PRICE_ASC" | "PRICE_DESC";

export type SearchFacetName = "category";

export interface SearchFilters {
  category?: string;
  // Cents in the settlement currency, both inclusive.
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  // Only products of these sources; every source when omitted.
  sourceKeys?: readonly string[];
}

export interface SearchQuery {
  // Words match with typo tolerance and the last one as a prefix; a "quoted
  // phrase" matches exactly. An empty text matches every product that passes
  // the filters.
  text: string;
  filters?: SearchFilters;
  // RELEVANCE by default.
  sort?: SearchSort;
  // Offset paging; the same query returns the same order on every page.
  page?: { offset: number; limit: number };
  facets?: readonly SearchFacetName[];
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface Facet {
  name: SearchFacetName;
  // Counted over every match of the query and its filters, most common first.
  values: FacetValue[];
}

export interface SearchResult {
  // Global product ids of the requested page, in order.
  ids: string[];
  // Matches of the query and its filters across all pages.
  total: number;
  // One entry per facet asked for in the query.
  facets: Facet[];
}

export interface SearchIndex {
  // Short, stable name, the value of SEARCH_ENGINE: "memory", "algolia"...
  readonly key: string;
  // Every write resolves once the change is indexed, even on engines that
  // index asynchronously: a new query sees it. A query identical to one made
  // before the write may still get the old answer for a short while, from
  // the engine's own query cache (Algolia keeps one for about a minute), so
  // callers treat results as a little behind the catalog.
  // Adds or replaces documents by id; repeating a call changes nothing.
  upsert(docs: readonly SearchDoc[]): Promise<void>;
  // Ids the index doesn't have are ignored.
  delete(ids: readonly string[]): Promise<void>;
  // Replaces the whole index with these documents (the daily
  // reconciliation). Searches keep answering from the old contents until
  // the new ones are complete: there is never an empty window.
  replaceAll(docs: readonly SearchDoc[]): Promise<void>;
  search(query: SearchQuery): Promise<SearchResult>;
}

// The engine didn't answer, or answered with an error. The API turns it into
// a retryable error instead of an empty result.
export class SearchUnavailableError extends Error {
  engineKey: string;
  constructor(engineKey: string, cause?: unknown) {
    super(`Search engine ${engineKey} is unavailable`, { cause });
    this.name = "SearchUnavailableError";
    this.engineKey = engineKey;
  }
}
