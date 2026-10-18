import { readReservation, reservationRef, type ReservationDoc } from "../db/reservations.js";
import { runTransaction } from "../db/transactions.js";
import {
  OutOfStockError,
  ReservationExpiredError,
  type CatalogSource,
  type Reservation,
} from "./ports.js";
import { reservationTtlMs } from "./reservationTtl.js";

// For a source that can't set units aside (capabilities.reservations false,
// e.g. a read-only vendor API), the reservation lives only in our
// reservations collection and the source's own stock is never touched.
// reserve checks that the units exist right now, and confirm checks again,
// since other buyers (ours or the source's) may have taken them meanwhile:
// with such a source a paid order can still find the units gone.
export const withCoreReservations = (source: CatalogSource): CatalogSource => {
  const available = async (localId: string) =>
    (await source.getProducts([localId]))[0]?.available ?? 0;

  return {
    key: source.key,
    displayName: source.displayName,
    capabilities: source.capabilities,
    listChanged: (since, page) => source.listChanged(since, page),
    getProducts: (localIds) => source.getProducts(localIds),

    async reserve(localId, quantity, key): Promise<Reservation> {
      // The source can't join our transaction, so it is asked first.
      const units = await available(localId);
      return runTransaction(async (tx) => {
        const existing = await readReservation(tx, key);
        if (existing) {
          return { reservationId: key, localId: existing.localId, quantity: existing.quantity, expiresAt: existing.expiresAt };
        }
        if (units < quantity) {
          throw new OutOfStockError(localId);
        }
        const now = new Date();
        const expiresAt = new Date(now.getTime() + reservationTtlMs(source.key));
        tx.set(reservationRef(key), {
          sourceKey: source.key,
          localId,
          quantity,
          status: "HELD",
          expiresAt,
          updatedAt: now,
        } satisfies ReservationDoc);
        return { reservationId: key, localId, quantity, expiresAt };
      });
    },

    async confirm({ reservationId, localId, quantity }) {
      if ((await available(localId)) < quantity) {
        throw new OutOfStockError(localId);
      }
      await runTransaction(async (tx) => {
        const existing = await readReservation(tx, reservationId);
        if (!existing || existing.status === "RELEASED") {
          throw new ReservationExpiredError(reservationId);
        }
        if (existing.status === "CONFIRMED") return;
        tx.update(reservationRef(reservationId), { status: "CONFIRMED", updatedAt: new Date() });
      });
    },

    async release({ reservationId, localId, quantity }) {
      await runTransaction(async (tx) => {
        const existing = await readReservation(tx, reservationId);
        if (existing && existing.status !== "HELD") return;
        tx.set(reservationRef(reservationId), {
          sourceKey: source.key,
          localId: existing?.localId ?? localId,
          quantity: existing?.quantity ?? quantity,
          status: "RELEASED",
          expiresAt: existing?.expiresAt ?? null,
          updatedAt: new Date(),
        } satisfies ReservationDoc);
      });
    },
  };
};
