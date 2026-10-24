import env from "../config/env.js";
import { SearchUnavailableError, type SearchIndex } from "./ports.js";

// A search engine is an external service: it can be slow as well as down.
// Every search gets a deadline, whatever the engine, so searchProducts
// answers fast with a retryable error instead of waiting on a slow engine.
// Writes (the sync job) have no deadline: nobody is waiting on them.

const DEFAULT_SEARCH_TIMEOUT_MS = 2000;

// SEARCH_TIMEOUT_MS, 2000 by default.
export const searchTimeoutMs = () => {
  const ms = Number(env.SEARCH_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_SEARCH_TIMEOUT_MS;
};

export class SearchTimeoutError extends Error {
  constructor(ms: number) {
    super(`The search engine didn't answer within ${ms} ms`);
    this.name = "SearchTimeoutError";
  }
}

// The same index, with searches that fail with SearchUnavailableError once
// they take longer than the deadline (SEARCH_TIMEOUT_MS, read on every
// search, unless ms is given). The engine's own call is left to finish in
// the background.
export const withSearchTimeout = (index: SearchIndex, ms?: number): SearchIndex => ({
  key: index.key,
  upsert: (docs) => index.upsert(docs),
  delete: (ids) => index.delete(ids),
  replaceAll: (docs) => index.replaceAll(docs),
  search: (query) =>
    new Promise((resolve, reject) => {
      const limit = ms ?? searchTimeoutMs();
      const timer = setTimeout(
        () => reject(new SearchUnavailableError(index.key, new SearchTimeoutError(limit))),
        limit
      );
      index
        .search(query)
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    }),
});
