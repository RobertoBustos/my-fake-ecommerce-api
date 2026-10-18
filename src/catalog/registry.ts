import env from "../config/env.js";
import { UnknownSourceError, type CatalogSource } from "./ports.js";
import { firestoreCatalogSource } from "./sources/firestore/adapter.js";

// Every adapter the code knows about, by key. CATALOG_SOURCES (a comma
// separated list, "fs" by default) says which of them are switched on.
const knownSources: Record<string, CatalogSource> = {
  [firestoreCatalogSource.key]: firestoreCatalogSource,
};

// Every product id today belongs to Firestore. Global ids that name their
// source replace this default.
export const DEFAULT_SOURCE_KEY = firestoreCatalogSource.key;

const enabledKeys = (): Set<string> =>
  new Set(
    (env.CATALOG_SOURCES ?? DEFAULT_SOURCE_KEY)
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean)
  );

export const getCatalogSource = (key: string): CatalogSource => {
  const source = knownSources[key];
  if (!source || !enabledKeys().has(key)) {
    throw new UnknownSourceError(key);
  }
  return source;
};
