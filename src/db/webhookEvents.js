import db from "../config/firestore.js";

const COLLECTION = "processedWebhookEvents";
const FIRESTORE_ALREADY_EXISTS = 6;

// Stripe guarantees "at least once" delivery: the same event can arrive
// more than once (timeout retries, etc). `create()` fails if the doc
// already exists, so this is an atomic "insert only if new" check without
// needing a manual transaction.
export const markEventProcessed = async (eventId) => {
  try {
    await db
      .collection(COLLECTION)
      .doc(eventId)
      .create({ processedAt: new Date().toISOString() });
    return false; // it was new, hadn't been processed before
  } catch (err) {
    if (err.code === FIRESTORE_ALREADY_EXISTS) {
      return true; // already processed
    }
    throw err;
  }
};

// Undoes markEventProcessed when handling the event failed, so Stripe's retry
// processes it again instead of being skipped as a duplicate.
export const unmarkEventProcessed = async (eventId) => {
  await db.collection(COLLECTION).doc(eventId).delete();
};
