import { measureInventoryQueue, processInventoryTasks } from "#src/catalog/inventoryQueue";
import { cancelAbandonedOrders } from "#src/db/abandonedOrders";
import { sweepExpiredReservations } from "#src/db/reservationSweep";
import { notifyOrderCancelled } from "#src/services/pushService";
import { logger } from "#src/utils/logger";
import { measure, runJob } from "./runJob.ts";

// The inventory job: queues the release of expired reservations, cancels
// the PAYMENT_PENDING orders left halfway (db/abandonedOrders.ts) and tells
// their users with a push, then runs every confirm and release that is due. It ships in the same image as the
// API, so a Cloud Run job runs it with `node dist/jobs/processInventory.js`
// (Cloud Scheduler starts it every 30 minutes); locally,
// `npm run inventory:process`. A failure exits with 1 so the run shows as failed.

await runJob("process-inventory", async () => {
  try {
    const swept = await sweepExpiredReservations();
    const abandoned = await cancelAbandonedOrders({ onCancelled: notifyOrderCancelled });
    const tasks = await processInventoryTasks();
    logger.info("Inventory queue processed", { swept, abandoned, tasks });
    await measure("the inventory queue", measureInventoryQueue);
    return 0;
  } catch (err) {
    logger.error("Inventory job failed", { error: (err as Error).message });
    return 1;
  }
});
