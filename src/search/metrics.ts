import { performance } from "node:perf_hooks";
import { metrics } from "#src/observability/metrics";
import { SearchUnavailableError, type SearchIndex } from "./ports.ts";
import { SearchTimeoutError } from "./timeout.ts";

// The same index, with the duration and outcome of every search recorded
// (search.request.duration), labeled with the engine: the engine's share of
// searchProducts, apart from reading the catalog. Wraps the deadline
// (withSearchTimeout), so a search that ran out of time counts as "timeout"
// at the deadline, not whenever the engine finally answered.
const outcomeOf = (err: unknown) =>
  err instanceof SearchUnavailableError && err.cause instanceof SearchTimeoutError ? "timeout" : "error";

export const withSearchMetrics = (index: SearchIndex): SearchIndex => ({
  key: index.key,
  upsert: (docs) => index.upsert(docs),
  delete: (ids) => index.delete(ids),
  replaceAll: (docs) => index.replaceAll(docs),
  search: async (query) => {
    const start = performance.now();
    const seconds = () => (performance.now() - start) / 1000;
    try {
      const result = await index.search(query);
      metrics.record("search.request.duration", seconds(), { engine: index.key, outcome: "ok" });
      return result;
    } catch (err) {
      metrics.record("search.request.duration", seconds(), { engine: index.key, outcome: outcomeOf(err) });
      throw err;
    }
  },
});
