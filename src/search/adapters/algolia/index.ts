import { algoliasearch, type Algoliasearch } from "algoliasearch";
import env from "../../../config/env.js";
import { SearchUnavailableError, type Facet, type SearchDoc, type SearchFilters, type SearchIndex } from "../../ports.js";
import { indexSettings, replicaNames } from "./settings.js";

// The SearchIndex port on Algolia (SEARCH_ENGINE=algolia). Records are the
// SearchDoc fields with the product id as objectID; replicas, filter syntax
// and facet maps stay in this folder.
//
// Two keys, both restricted to the ecomapi_* indices: the search key (ACL
// search) is all the API needs; writing, configuring and the contract suite
// use the indexer key. A process with only the search key can search but not
// write.

export interface AlgoliaConfig {
  appId: string;
  // The primary index; its price replicas take its name plus a suffix.
  indexName: string;
  searchKey?: string;
  indexerKey?: string;
}

export class AlgoliaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlgoliaConfigError";
  }
}

export const algoliaConfigFromEnv = (): AlgoliaConfig => {
  const appId = env.ALGOLIA_APP_ID?.trim();
  const indexName = env.ALGOLIA_INDEX?.trim();
  const searchKey = env.ALGOLIA_SEARCH_KEY?.trim() || undefined;
  const indexerKey = env.ALGOLIA_INDEXER_KEY?.trim() || undefined;
  const missing = [
    !appId && "ALGOLIA_APP_ID",
    !indexName && "ALGOLIA_INDEX",
    !searchKey && !indexerKey && "ALGOLIA_SEARCH_KEY or ALGOLIA_INDEXER_KEY",
  ].filter(Boolean);
  if (missing.length) throw new AlgoliaConfigError(`SEARCH_ENGINE=algolia needs ${missing.join(", ")}`);
  return { appId: appId!, indexName: indexName!, searchKey, indexerKey };
};

const indexerClient = (config: AlgoliaConfig) => {
  if (!config.indexerKey) {
    throw new AlgoliaConfigError("Writing to the Algolia index needs ALGOLIA_INDEXER_KEY; the search key can only search");
  }
  return algoliasearch(config.appId, config.indexerKey);
};

// Any failure of a call to Algolia, so the API answers with a retryable error
// instead of an empty result.
const call = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw new SearchUnavailableError("algolia", error);
  }
};

const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// The filters in Algolia's syntax, or null when nothing can match (an empty
// list of sources), which Algolia's syntax has no way to say.
export const toAlgoliaFilters = (filters: SearchFilters = {}): string | null => {
  if (filters.sourceKeys?.length === 0) return null;
  const parts: string[] = [];
  if (filters.category !== undefined) parts.push(`category:${quote(filters.category)}`);
  if (filters.minPrice !== undefined) parts.push(`settlementPrice >= ${filters.minPrice}`);
  if (filters.maxPrice !== undefined) parts.push(`settlementPrice <= ${filters.maxPrice}`);
  if (filters.inStock !== undefined) parts.push(`inStock:${filters.inStock}`);
  if (filters.sourceKeys) parts.push(`(${filters.sourceKeys.map((key) => `sourceKey:${quote(key)}`).join(" OR ")})`);
  return parts.join(" AND ");
};

// A document without a settlement price has no settlementPrice attribute,
// so numeric filters leave it out and the price replicas rank it last.
const toRecord = ({ id, settlementPrice, ...fields }: SearchDoc) => ({
  objectID: id,
  ...fields,
  ...(settlementPrice === null ? {} : { settlementPrice }),
});

const BATCH_SIZE = 1000;

export const createAlgoliaSearchIndex = (config: AlgoliaConfig = algoliaConfigFromEnv()): SearchIndex => {
  const searcher: Algoliasearch = algoliasearch(config.appId, (config.searchKey ?? config.indexerKey)!);
  let writer: Algoliasearch | undefined;
  const write = () => (writer ??= indexerClient(config));
  const replicas = replicaNames(config.indexName);
  const { indexName } = config;

  return {
    key: "algolia",

    async upsert(docs) {
      if (!docs.length) return;
      const client = write();
      await call(() =>
        client.saveObjects({ indexName, objects: docs.map(toRecord), waitForTasks: true, batchSize: BATCH_SIZE }),
      );
    },

    async delete(ids) {
      if (!ids.length) return;
      const client = write();
      await call(() =>
        client.deleteObjects({ indexName, objectIDs: [...ids], waitForTasks: true, batchSize: BATCH_SIZE }),
      );
    },

    async replaceAll(docs) {
      const client = write();
      // Fills a temporary copy of the index and moves it over the old one in
      // one step, so searches keep answering from the old records until then.
      await call(() => client.replaceAllObjects({ indexName, objects: docs.map(toRecord), batchSize: BATCH_SIZE }));
    },

    async search(query) {
      const names = query.facets ?? [];
      const filters = toAlgoliaFilters(query.filters);
      if (filters === null) return { ids: [], total: 0, facets: names.map((name) => ({ name, values: [] })) };
      const sort = query.sort ?? "RELEVANCE";
      const { offset = 0, limit = 20 } = query.page ?? {};
      const response = await call(() =>
        searcher.searchSingleIndex({
          indexName: sort === "RELEVANCE" ? indexName : replicas[sort],
          searchParams: {
            query: query.text,
            filters,
            offset,
            length: limit,
            facets: [...names],
            attributesToRetrieve: [],
          },
        }),
      );
      const facets: Facet[] = names.map((name) => ({
        name,
        values: Object.entries(response.facets?.[name] ?? {})
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
      }));
      return { ids: response.hits.map((hit) => hit.objectID), total: response.nbHits ?? 0, facets };
    },
  };
};

// Applies settings.ts to the primary index and its replicas, creating them if
// they don't exist. Idempotent. Returns the indices it configured.
export const configureAlgoliaIndex = async (config: AlgoliaConfig = algoliaConfigFromEnv()): Promise<string[]> => {
  const client = indexerClient(config);
  const steps = indexSettings(config.indexName);
  for (const { indexName, settings } of steps) {
    const { taskID } = await client.setSettings({ indexName, indexSettings: settings });
    await client.waitForTask({ indexName, taskID });
  }
  return steps.map((step) => step.indexName);
};

// Deletes the primary index and its replicas: the cleanup of a test index.
export const dropAlgoliaIndex = async (config: AlgoliaConfig): Promise<void> => {
  const client = indexerClient(config);
  // A replica can't be deleted while it is still attached to its primary.
  const { taskID } = await client.setSettings({ indexName: config.indexName, indexSettings: { replicas: [] } });
  await client.waitForTask({ indexName: config.indexName, taskID });
  for (const indexName of [...Object.values(replicaNames(config.indexName)), config.indexName]) {
    await client.deleteIndex({ indexName });
  }
};
