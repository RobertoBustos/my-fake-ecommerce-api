import { processInventoryTasks } from "../catalog/inventoryQueue.js";
import { sweepExpiredReservations } from "../db/reservationSweep.js";
import { logger } from "../utils/logger.js";

// The inventory job: queues the release of expired reservations, then runs
// every confirm and release that is due. It ships in the same image as the
// API, so a Cloud Run job runs it with `node dist/jobs/processInventory.js`
// (Cloud Scheduler starts it every few minutes); locally,
// `npm run inventory:process`. A failure exits with 1 so the run shows as failed.
try {
  const swept = await sweepExpiredReservations();
  const tasks = await processInventoryTasks();
  logger.info("Inventory queue processed", { swept, tasks });
  process.exit(0);
} catch (err) {
  logger.error("Inventory job failed", { error: (err as Error).message });
  process.exit(1);
}
