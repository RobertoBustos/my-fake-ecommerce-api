import env from "../config/env.js";
import { configureAlgoliaIndex, createAlgoliaSearchIndex } from "./adapters/algolia/index.js";
import { createMemorySearchIndex } from "./adapters/memory.js";
import type { SearchIndex } from "./ports.js";

interface SearchEngine {
  create(): SearchIndex;
  // Applies the engine's index settings (npm run search:configure);
  // idempotent. Returns what it configured. Engines with nothing to set up
  // leave it out.
  configure?(): Promise<string[]>;
}

// Every search engine the code knows about, by the value of SEARCH_ENGINE.
// Each is built on first use and then shared, so the sync job and the
// resolvers of one process talk to the same index.
const knownEngines: Record<string, SearchEngine> = {
  memory: { create: createMemorySearchIndex },
  algolia: { create: () => createAlgoliaSearchIndex(), configure: () => configureAlgoliaIndex() },
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

const engineFor = (key: string) => {
  const engine = knownEngines[key];
  if (!engine) throw new UnknownSearchEngineError(key);
  return engine;
};

// Called at startup: a SEARCH_ENGINE the code doesn't know, or an engine
// missing its settings (keys, index name), stops the server instead of
// failing on the first search. Leaving it unset is allowed while nothing
// searches yet.
export const assertSearchEngineConfig = () => {
  if (configuredKey() !== undefined) getSearchIndex();
};

export const getSearchIndex = (): SearchIndex => {
  const key = configuredKey();
  if (key === undefined) throw new SearchEngineNotConfiguredError();
  const engine = engineFor(key);
  let index = built.get(key);
  if (!index) {
    index = engine.create();
    built.set(key, index);
  }
  return index;
};

// Applies the index settings of the engine SEARCH_ENGINE names. Returns what
// it configured, empty for an engine with nothing to set up.
export const configureSearchEngine = async (): Promise<string[]> => {
  const key = configuredKey();
  if (key === undefined) throw new SearchEngineNotConfiguredError();
  return (await engineFor(key).configure?.()) ?? [];
};
