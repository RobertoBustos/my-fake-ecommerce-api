import { randomUUID } from "crypto";
import {
  configureAlgoliaIndex,
  createAlgoliaSearchIndex,
  dropAlgoliaIndex,
} from "../../src/search/adapters/algolia/index.js";
import { describeSearchIndexContract } from "./searchIndex.contract.js";

// The contract against a real Algolia index, run by hand with the indexer key
// (npm run test:search:algolia); CI only runs it against the in-memory index.
// Each run configures its own ecomapi_contract_<id> index and its replicas
// and deletes them at the end.
//
// Slow by nature: each Algolia task takes several seconds to publish on the
// free plan, and a replaceAll chains four of them (copy, fill, copy, move).

describeSearchIndexContract(
  "Algolia",
  async () => {
    const appId = process.env.ALGOLIA_APP_ID;
    const indexerKey = process.env.ALGOLIA_INDEXER_KEY;
    if (!appId || !indexerKey) throw new Error("The Algolia contract needs ALGOLIA_APP_ID and ALGOLIA_INDEXER_KEY");
    const config = { appId, indexerKey, indexName: `ecomapi_contract_${randomUUID().slice(0, 8)}` };
    await configureAlgoliaIndex(config);
    return { index: createAlgoliaSearchIndex(config), cleanup: () => dropAlgoliaIndex(config) };
  },
  { timeout: 300_000 },
);
