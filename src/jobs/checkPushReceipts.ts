import { checkPushReceipts } from "#src/services/pushReceipts";
import { logger } from "#src/utils/logger";
import { runJob } from "./runJob.ts";

// The push receipts job: a ticket "ok" from Expo only means Expo took the
// message, so this reads each ticket's receipt to learn whether it reached
// the device, and deletes the tokens of apps that were uninstalled
// (services/pushReceipts.ts). It ships in the same image as the API, so a
// Cloud Run job runs it with `node dist/jobs/checkPushReceipts.js` (Cloud
// Scheduler starts it every 30 minutes); locally, `npm run push:receipts`.
// A failure exits with 1 so the run shows as failed.

await runJob("check-push-receipts", async () => {
  try {
    const receipts = await checkPushReceipts();
    logger.info("Push receipts checked", { ...receipts });
    return 0;
  } catch (err) {
    logger.error("Push receipts job failed", { error: (err as Error).message });
    return 1;
  }
});
