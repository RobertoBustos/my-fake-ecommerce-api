import { retryInventoryTask } from "../src/catalog/inventoryQueue.js";
import { getInventoryTask } from "../src/db/inventoryTasks.js";

// Puts a FAILED inventory task back in the queue with a fresh set of
// attempts and runs it once: `npm run inventory:retry -- <taskId>`.
const taskId = process.argv[2];
if (!taskId) {
  console.error("Usage: npm run inventory:retry -- <taskId>");
  process.exit(1);
}
console.log(`Project: ${process.env.FIRESTORE_PROJECT_ID ?? "(emulator default)"}`);
const status = await retryInventoryTask(taskId);
if (status === null) {
  console.error(`No inventory task ${taskId}`);
  process.exit(1);
}
const task = await getInventoryTask(taskId);
console.log(`Task ${taskId}: ${status} after ${task?.attempts ?? 0} attempt(s)`);
if (task?.lastError) console.log(`Last error: ${task.lastError}`);
process.exit(status === "FAILED" ? 1 : 0);
