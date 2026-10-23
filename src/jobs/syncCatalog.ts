import { syncCatalog } from "../catalog/catalogSync.js";
import { logger } from "../utils/logger.js";

// The catalog sync job: pulls what changed in every switched-on source into
// the catalog index, and reconciles each source when it is due. It feeds the
// search index too when SEARCH_ENGINE names one; a search write that fails
// is a WARNING and doesn't fail the run. It ships in
// the same image as the API, so a Cloud Run job runs it with
// `node dist/jobs/syncCatalog.js` (Cloud Scheduler starts it every few
// minutes); locally, `npm run catalog:sync`. Options:
//   --reconcile        reconcile every selected source now
//   --source <key>     only that source (repeatable)
// A failure exits with 1 so the run shows as failed.
const args = process.argv.slice(2);
const sourceKeys = args.flatMap((arg, i) => (arg === "--source" && args[i + 1] ? [args[i + 1]] : []));

try {
  const { synced, failed, searchFailed } = await syncCatalog({
    reconcile: args.includes("--reconcile"),
    sourceKeys: sourceKeys.length > 0 ? sourceKeys : undefined,
  });
  logger.info("Catalog synced", { synced, failed: failed.map(({ sourceKey }) => sourceKey), searchFailed });
  process.exit(failed.length > 0 ? 1 : 0);
} catch (err) {
  logger.error("Catalog sync job failed", { error: (err as Error).message });
  process.exit(1);
}
