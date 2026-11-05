import { syncCatalog } from "#src/catalog/catalogSync";
import { measureExchangeRateAges } from "#src/pricing/refreshRates";
import { logger } from "#src/utils/logger";
import { measure, runJob } from "./runJob.ts";

// The catalog sync job: pulls what changed in every switched-on source into
// the catalog index, and reconciles each source when it is due. It feeds the
// search index too when SEARCH_ENGINE names one; a search write that fails
// is a WARNING and doesn't fail the run. It ships in
// the same image as the API, so a Cloud Run job runs it with
// `node dist/jobs/syncCatalog.js` (Cloud Scheduler starts it every
// hour); locally, `npm run catalog:sync`. Options:
//   --reconcile        reconcile every selected source now
//   --source <key>     only that source (repeatable)
// A failure exits with 1 so the run shows as failed.

const args = process.argv.slice(2);
const sourceKeys = args.flatMap((arg, i) => (arg === "--source" && args[i + 1] ? [args[i + 1]] : []));

await runJob("sync-catalog", async () => {
  try {
    const { synced, failed, searchFailed } = await syncCatalog({
      reconcile: args.includes("--reconcile"),
      sourceKeys: sourceKeys.length > 0 ? sourceKeys : undefined,
    });
    logger.info("Catalog synced", { synced, failed: failed.map(({ sourceKey }) => sourceKey), searchFailed });
    await measure("exchange rate ages", () => measureExchangeRateAges());
    return failed.length > 0 ? 1 : 0;
  } catch (err) {
    logger.error("Catalog sync job failed", { error: (err as Error).message });
    return 1;
  }
});
