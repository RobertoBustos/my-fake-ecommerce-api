import env from "#src/config/env";
import { withCoreReservations } from "./coreReservations.ts";
import { UnknownSourceError, type CatalogSource } from "./ports.ts";
import { firestoreCatalogSource } from "./sources/firestore/adapter.ts";

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

// The switched-on sources, in CATALOG_SOURCES order; keys the code doesn't
// know are skipped.
export const listEnabledSources = (): CatalogSource[] =>
  [...enabledKeys()].flatMap((key) => (knownSources[key] ? [knownSources[key]] : []));
