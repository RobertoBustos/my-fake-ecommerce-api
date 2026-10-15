import db from "../config/firestore.js";

const COLLECTION = "processedWebhookEvents";
const FIRESTORE_ALREADY_EXISTS = 6;

// Stripe garantiza entrega "al menos una vez": el mismo evento puede llegar
// más de una vez (reintentos por timeout, etc). `create()` falla si el doc
// ya existe, así que es un "insertar solo si es nuevo" atómico sin necesitar
// una transacción manual.
export const markEventProcessed = async (eventId) => {
  try {
    await db
      .collection(COLLECTION)
      .doc(eventId)
      .create({ processedAt: new Date().toISOString() });
    return false; // era nuevo, no se había procesado antes
  } catch (err) {
    if (err.code === FIRESTORE_ALREADY_EXISTS) {
      return true; // ya se había procesado
    }
    throw err;
  }
};
