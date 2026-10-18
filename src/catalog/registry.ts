import env from "../config/env.js";
import { withCoreReservations } from "./coreReservations.js";
import { UnknownSourceError, type CatalogSource } from "./ports.js";
import { firestoreCatalogSource } from "./sources/firestore/adapter.js";

// Every adapter the code knows about, by key. CATALOG_SOURCES (a comma
// separated list, "fs" by default) says which of them are switched on.
// A source that can't reserve stock gets its reservations kept by us.
const withReservations = (source: CatalogSource) =>
  source.capabilities.reservations ? source : withCoreReservations(source);

const knownSources: Record<string, CatalogSource> = Object.fromEntries(
  [firestoreCatalogSource].map((source) => [source.key, withReservations(source)])
);

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
