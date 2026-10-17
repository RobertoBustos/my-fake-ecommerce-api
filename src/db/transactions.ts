import type { Transaction } from "firebase-admin/firestore";
import db from "../config/firestore.js";

// gRPC status code Firestore uses when a transaction loses a lock fight and
// runs out of retries.
const ABORTED = 10;
// Firestore's default is 5. Purchases of a popular product all write the same
// product doc, so give them more room before giving up.
const MAX_ATTEMPTS = 10;

export class TransactionContentionError extends Error {
  constructor(cause: unknown) {
    super("Too many concurrent changes to the same data, try again", { cause });
    this.name = "TransactionContentionError";
  }
}

// db.runTransaction with more retries, for writes that many requests can race
// on (stock, order status). A transaction that still can't get its locks
// after every retry becomes TransactionContentionError, so the API can answer
// "try again" instead of an internal error.
export const runTransaction = async <T>(
  updateFunction: (tx: Transaction) => Promise<T>
): Promise<T> => {
  try {
    return await db.runTransaction(updateFunction, { maxAttempts: MAX_ATTEMPTS });
  } catch (err) {
    if ((err as { code?: number }).code === ABORTED) {
      throw new TransactionContentionError(err);
    }
    throw err;
  }
};
