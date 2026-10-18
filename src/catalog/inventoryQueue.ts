import env from "../config/env.js";
import {
  getInventoryTask,
  inventoryTaskRef,
  listDueInventoryTasks,
  readInventoryTask,
  type InventoryTask,
  type InventoryTaskStatus,
} from "../db/inventoryTasks.js";
import { runTransaction } from "../db/transactions.js";
import { logger } from "../utils/logger.js";
import { OutOfStockError, ReservationExpiredError } from "./ports.js";
import { getCatalogSource } from "./registry.js";

// Runs the confirm and release tasks of the outbox against their sources.
// Every source call carries an idempotency key, so running a task twice
// (inline right after its commit and again from the job) is harmless.

const DEFAULT_MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 60 * 60_000;
const PAGE_SIZE = 100;

const maxAttempts = () => {
  const value = Number(env.INVENTORY_TASK_MAX_ATTEMPTS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_ATTEMPTS;
};

// 1, 2, 4... minutes after each failed attempt, at most an hour: with the
// default 8 attempts a source gets about two hours to come back.
export const retryDelayMs = (attempts: number) =>
  Math.min(BASE_DELAY_MS * 2 ** (attempts - 1), MAX_DELAY_MS);

// Retrying can't fix these: the reservation is gone, or a source that we
// keep reservations for no longer has the units.
const isPermanent = (err: unknown) =>
  err instanceof ReservationExpiredError || err instanceof OutOfStockError;

const logFailure = (task: InventoryTask, attempts: number, error: string) => {
  const details = {
    taskId: task.id,
    orderId: task.orderId,
    sourceKey: task.sourceKey,
    productId: task.reservation.localId,
    quantity: task.reservation.quantity,
    reservationId: task.reservation.reservationId,
    reason: task.reason,
    attempts,
    error,
  };
  // A confirm comes after Stripe charged: the order stays COMPLETE (the
  // money decides), and someone has to settle the units with the source or
  // refund the order.
  if (task.action === "confirm") {
    logger.error("Sold units not confirmed in their source", details);
  } else {
    logger.error("Reserved stock not released", details);
  }
};

const execute = async (task: InventoryTask) => {
  const source = getCatalogSource(task.sourceKey);
  const key = `${task.reservation.reservationId}-${task.action}`;
  if (task.action === "confirm") {
    await source.confirm(task.reservation, key);
  } else {
    await source.release(task.reservation, key);
  }
};

// Runs one task if it is still PENDING and records the outcome. Never
// throws for a source error: the task keeps it and is retried later.
// Returns the task's status afterwards, or null if there is no such task.
export const runInventoryTask = async (id: string): Promise<InventoryTaskStatus | null> => {
  const task = await getInventoryTask(id);
  if (!task || task.status !== "PENDING") return task?.status ?? null;

  let error: unknown = null;
  try {
    await execute(task);
  } catch (err) {
    error = err;
  }

  return runTransaction(async (tx) => {
    const current = await readInventoryTask(tx, id);
    // Another run already settled it.
    if (!current || current.status !== "PENDING") return current?.status ?? null;
    const now = new Date();
    if (error === null) {
      tx.update(inventoryTaskRef(id), {
        status: "DONE",
        attempts: current.attempts + 1,
        nextAttemptAt: null,
        lastError: null,
        updatedAt: now,
      });
      return "DONE";
    }
    const attempts = current.attempts + 1;
    const message = (error as Error).message;
    if (isPermanent(error) || attempts >= maxAttempts()) {
      tx.update(inventoryTaskRef(id), {
        status: "FAILED",
        attempts,
        nextAttemptAt: null,
        lastError: message,
        updatedAt: now,
      });
      logFailure(current, attempts, message);
      return "FAILED";
    }
    tx.update(inventoryTaskRef(id), {
      attempts,
      nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
      lastError: message,
      updatedAt: now,
    });
    logger.warn("Inventory task failed; will retry", {
      taskId: id,
      action: current.action,
      sourceKey: current.sourceKey,
      attempts,
      error: message,
    });
    return "PENDING";
  });
};

// Right after the write that queued them commits, so the units move as soon
// as they used to; what fails here stays queued for the job. It never
// throws: the caller's change already committed and must not look failed.
export const runInventoryTasks = async (ids: string[]) => {
  for (const id of ids) {
    try {
      await runInventoryTask(id);
    } catch (err) {
      logger.warn("Inventory task left for the inventory job", {
        taskId: id,
        error: (err as Error).message,
      });
    }
  }
};

// The job's pass over the queue: every task due by `now`. A task that fails
// again is due later, so it doesn't come back in this pass.
export const processInventoryTasks = async ({ now = new Date() }: { now?: Date } = {}) => {
  const counts = { done: 0, failed: 0, retrying: 0 };
  const seen = new Set<string>();
  for (;;) {
    const due = (await listDueInventoryTasks(now, PAGE_SIZE)).filter((task) => !seen.has(task.id));
    if (due.length === 0) break;
    for (const task of due) {
      seen.add(task.id);
      const status = await runInventoryTask(task.id);
      if (status === "DONE") counts.done += 1;
      else if (status === "FAILED") counts.failed += 1;
      else if (status === "PENDING") counts.retrying += 1;
    }
  }
  return counts;
};

// For a person, after fixing what made a task fail: puts it back in the
// queue with a fresh set of attempts and runs it once.
export const retryInventoryTask = async (id: string): Promise<InventoryTaskStatus | null> => {
  const reset = await runTransaction(async (tx) => {
    const task = await readInventoryTask(tx, id);
    if (!task) return false;
    if (task.status === "DONE") return true;
    tx.update(inventoryTaskRef(id), {
      status: "PENDING",
      attempts: 0,
      nextAttemptAt: new Date(),
      updatedAt: new Date(),
    });
    return true;
  });
  return reset ? runInventoryTask(id) : null;
};
