import { GraphQLError } from "graphql";

// The contract every catalog source implements (Firestore today; MySQL,
// MongoDB, Supabase or a vendor API later). The rest of the API only knows
// these types: no source leaks its database client past its adapter.

export interface SourceProduct {
  // Id inside the source.
  localId: string;
  title: string;
  description: string;
  // Already mapped to the shared category names.
  category: string;
  image: string;
  // ISO 4217.
  currency: string;
  // Cents.
  unitPrice: number;
  purchaseLimits: { min: number; max: number };
  // Units that can be sold right now.
  available: number;
  // For incremental sync; null when the source doesn't track it.
  updatedAt: Date | null;
}

// Units set aside for a cart item. expiresAt is null while reservations don't
// expire; the source keeps localId and quantity so it can put the units back.
export interface Reservation {
  reservationId: string;
  localId: string;
  quantity: number;
  expiresAt: Date | null;
}

export interface ChangedProducts {
  items: SourceProduct[];
  deletedIds: string[];
  nextCursor?: string;
}

export interface CatalogSource {
  // Short, stable name: "fs", "mysql-outlet"... Part of every global
  // product id, so it never changes once products are in carts.
  readonly key: string;
  // What the app may show as the product's origin (Product.source).
  readonly displayName: string;
  readonly capabilities: { reservations: boolean; changeFeed: boolean };

  // Catalog (reads)
  listChanged(
    since: Date | null,
    page: { cursor?: string; limit: number }
  ): Promise<ChangedProducts>;
  getProducts(localIds: readonly string[]): Promise<SourceProduct[]>;

  // Inventory (writes). Every call carries an idempotency key.
  reserve(localId: string, quantity: number, key: string): Promise<Reservation>;
  confirm(reservation: Reservation, key: string): Promise<void>;
  release(reservation: Reservation, key: string): Promise<void>;
}

export class OutOfStockError extends Error {
  productId: string;
  constructor(productId: string) {
    super(`Not enough stock for product ${productId}`);
    this.name = "OutOfStockError";
    this.productId = productId;
  }
}

export class SourceUnavailableError extends Error {
  sourceKey: string;
  constructor(sourceKey: string, cause?: unknown) {
    super(`Catalog source ${sourceKey} is unavailable`, { cause });
    this.name = "SourceUnavailableError";
    this.sourceKey = sourceKey;
  }
}

export class ReservationExpiredError extends Error {
  reservationId: string;
  constructor(reservationId: string) {
    super(`Reservation ${reservationId} has expired`);
    this.name = "ReservationExpiredError";
    this.reservationId = reservationId;
  }
}

// An unknown source looks like an unknown product to the client.
export class UnknownSourceError extends GraphQLError {
  constructor(sourceKey: string) {
    super(`Unknown catalog source ${sourceKey}`, {
      extensions: { code: "NOT_FOUND", invalidArgument: "productId" },
    });
    this.name = "UnknownSourceError";
  }
}
