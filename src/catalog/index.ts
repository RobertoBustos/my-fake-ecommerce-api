import type { Product } from "../types/models.js";
import type { Reservation, SourceProduct } from "./ports.js";
import { DEFAULT_SOURCE_KEY, getCatalogSource } from "./registry.js";
import { logger } from "../utils/logger.js";

export {
  OutOfStockError,
  ReservationExpiredError,
  SourceUnavailableError,
  UnknownSourceError,
} from "./ports.js";
export type { CatalogSource, Reservation, SourceProduct } from "./ports.js";
export { DEFAULT_SOURCE_KEY, getCatalogSource } from "./registry.js";

// The shape the rest of the API (and the GraphQL Product type) uses.
export const toProduct = ({ localId, available, updatedAt: _updatedAt, ...rest }: SourceProduct): Product => ({
  ...rest,
  id: localId,
  stock: available,
});

export const getCatalogProducts = async (ids: readonly string[]): Promise<Product[]> => {
  const products = await getCatalogSource(DEFAULT_SOURCE_KEY).getProducts(ids);
  return products.map(toProduct);
};

export const getCatalogProduct = async (id: string): Promise<Product | null> =>
  (await getCatalogProducts([id]))[0] ?? null;

// Puts reserved units back. Callers run it after their own write has
// committed, so a failure here can't be rolled back with it: it is logged
// with everything needed to return the units by hand.
export const releaseReservation = async (reservation: Reservation, reason: string) => {
  const source = getCatalogSource(DEFAULT_SOURCE_KEY);
  try {
    await source.release(reservation, `${reservation.reservationId}-release`);
  } catch (err) {
    logger.error("Could not release reserved stock", {
      reason,
      sourceKey: source.key,
      productId: reservation.localId,
      quantity: reservation.quantity,
      reservationId: reservation.reservationId,
      error: (err as Error).message,
    });
  }
};
