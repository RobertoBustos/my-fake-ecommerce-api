import env from "../config/env.js";
import { createMemorySearchIndex } from "./adapters/memory.js";
import type { SearchIndex } from "./ports.js";

// Every search engine the code knows about, by the value of SEARCH_ENGINE.
// Each is built on first use and then shared, so the sync job and the
// resolvers of one process talk to the same index.
const knownEngines: Record<string, () => SearchIndex> = {
  memory: createMemorySearchIndex,
};

const built = new Map<string, SearchIndex>();

export class UnknownSearchEngineError extends Error {
  constructor(key: string) {
    super(`Unknown search engine "${key}" in SEARCH_ENGINE; known engines: ${Object.keys(knownEngines).join(", ")}`);
    this.name = "UnknownSearchEngineError";
  }
}

export class SearchEngineNotConfiguredError extends Error {
  constructor() {
    super("SEARCH_ENGINE is not set, so there is no search index to use");
    this.name = "SearchEngineNotConfiguredError";
  }
}

const configuredKey = () => env.SEARCH_ENGINE?.trim() || undefined;

// Called at startup: a SEARCH_ENGINE the code doesn't know stops the server
// instead of failing on the first search. Leaving it unset is allowed while
// nothing searches yet.
export const assertSearchEngineConfig = () => {
  const key = configuredKey();
  if (key !== undefined && !knownEngines[key]) throw new UnknownSearchEngineError(key);
};

export const getSearchIndex = (): SearchIndex => {
  const key = configuredKey();
  if (key === undefined) throw new SearchEngineNotConfiguredError();
  const create = knownEngines[key];
  if (!create) throw new UnknownSearchEngineError(key);
  let index = built.get(key);
  if (!index) {
    index = create();
    built.set(key, index);
  }
  return index;
};
