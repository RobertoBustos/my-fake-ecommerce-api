import { configureSearchEngine } from "../src/search/registry.js";

// Applies the index settings of the engine SEARCH_ENGINE names (searchable
// attributes, facets, ranking, sort replicas), creating the index if it
// doesn't exist: `npm run search:configure`. Idempotent; run it before the
// first sync of a new index and after changing an adapter's settings. The
// settings themselves live in the adapter, never here.
const engine = process.env.SEARCH_ENGINE?.trim();
if (!engine) {
  console.error("Set SEARCH_ENGINE to the engine to configure (e.g. SEARCH_ENGINE=algolia)");
  process.exit(1);
}
const configured = await configureSearchEngine();
if (!configured.length) console.log(`Search engine ${engine}: nothing to configure`);
else console.log(`Search engine ${engine}: configured ${configured.join(", ")}`);
