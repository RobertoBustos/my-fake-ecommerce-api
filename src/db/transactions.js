import db from "../config/firestore.js";

// gRPC status code Firestore uses when a transaction loses a lock fight and
// runs out of retries.
const ABORTED = 10;
// Firestore's default is 5. Purchases of a popular product all write the same
// product doc, so give them more room before giving up.
const MAX_ATTEMPTS = 10;

export class TransactionContentionError extends Error {
  constructor(cause) {
    super("Too many concurrent changes to the same data, try again", { cause });
    this.name = "TransactionContentionError";
  }
}

// runTransaction for writes that touch stock. A transaction that still can't
// get its locks after every retry becomes TransactionContentionError, so the
// API can answer "try again" instead of an internal error.
export const runStockTransaction = async (updateFunction) => {
  try {
    return await db.runTransaction(updateFunction, { maxAttempts: MAX_ATTEMPTS });
  } catch (err) {
    if (err.code === ABORTED) {
      throw new TransactionContentionError(err);
    }
    throw err;
  }
};
