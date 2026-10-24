import DataLoader from "dataloader";
import type { SearchQuery, SearchResult } from "../search/ports.js";
import { getSearchIndex } from "../search/registry.js";

// New instance per request: identical searches made while answering one
// request (two aliases of the same searchProducts) reach the engine once,
// and a failed one fails all of them with the same error. The key is the
// whole query, so any difference in text, filters, sort or page is a search
// of its own. The port has no batch search, so each key is its own call.
export const createSearchLoader = () =>
  new DataLoader<SearchQuery, SearchResult, string>(
    (queries) =>
      Promise.all(queries.map((query) => getSearchIndex().search(query).catch((err: unknown) => err as Error))),
    { cacheKeyFn: (query) => JSON.stringify(query) }
  );
