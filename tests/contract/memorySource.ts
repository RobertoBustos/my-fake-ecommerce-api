import { CATALOG_CATEGORIES, type CatalogCategory } from "../../src/catalog/categories.js";
import {
  OutOfStockError,
  ReservationExpiredError,
  type CatalogSource,
  type Reservation,
  type SourceProduct,
} from "../../src/catalog/ports.js";
import { reservationTtlMs } from "../../src/catalog/reservationTtl.js";
import type { ContractHarness, ContractProduct } from "./catalogSource.contract.js";

// An in-memory catalog source that follows the contract: the reference the
// contract suite is checked against, and the base of the broken adapters
// that prove each check catches what it should. Its own category names
// differ from the shared ones, so the mapping is exercised.

const NATIVE_CATEGORIES: Record<CatalogCategory, string> = {
  electronics: "Electrónica",
  jewelery: "Joyería",
  "men's clothing": "Ropa de hombre",
  "women's clothing": "Ropa de mujer",
};

const toShared = (native: string): string =>
  CATALOG_CATEGORIES.find((category) => NATIVE_CATEGORIES[category] === native) ?? native;

interface StoredProduct {
  localId: string;
  nativeCategory: string;
  stock: number;
  updatedAt: Date;
}

interface StoredReservation {
  localId: string;
  quantity: number;
  status: "HELD" | "CONFIRMED" | "RELEASED";
  expiresAt: Date;
}

export interface MemorySource extends CatalogSource {
  products: Map<string, StoredProduct>;
  reservations: Map<string, StoredReservation>;
  toSourceProduct(product: StoredProduct): SourceProduct;
}

export const createMemorySource = ({
  key = "mem",
  reservations = true,
  tracksChanges = true,
}: { key?: string; reservations?: boolean; tracksChanges?: boolean } = {}): MemorySource => {
  const products = new Map<string, StoredProduct>();
  const held = new Map<string, StoredReservation>();

  const toSourceProduct = (product: StoredProduct): SourceProduct => ({
    localId: product.localId,
    title: `Product ${product.localId}`,
    description: "",
    category: toShared(product.nativeCategory),
    image: "",
    currency: "MXN",
    unitPrice: 1500,
    purchaseLimits: { min: 1, max: 10 },
    available: product.stock,
    updatedAt: tracksChanges ? product.updatedAt : null,
  });

  const unsupported = async (): Promise<never> => {
    throw new Error(`Source ${key} doesn't reserve; the core keeps its reservations`);
  };

  return {
    key,
    displayName: "In-memory test source",
    capabilities: { reservations, changeFeed: false },
    products,
    reservations: held,
    toSourceProduct,

    async listChanged(since, { cursor, limit }) {
      const sorted = [...products.values()]
        .filter((product) => !tracksChanges || since === null || product.updatedAt > since)
        .sort((a, b) => a.localId.localeCompare(b.localId))
        .filter((product) => cursor === undefined || product.localId > cursor);
      const items = sorted.slice(0, limit);
      return {
        items: items.map(toSourceProduct),
        deletedIds: [],
        nextCursor: sorted.length > limit ? items.at(-1)?.localId : undefined,
      };
    },

    async getProducts(localIds) {
      return localIds.flatMap((id) => {
        const product = products.get(id);
        return product ? [toSourceProduct(product)] : [];
      });
    },

    reserve: !reservations
      ? unsupported
      : async (localId, quantity, reserveKey): Promise<Reservation> => {
          const existing = held.get(reserveKey);
          if (existing) {
            return { reservationId: reserveKey, localId: existing.localId, quantity: existing.quantity, expiresAt: existing.expiresAt };
          }
          const product = products.get(localId);
          if (!product || product.stock < quantity) throw new OutOfStockError(localId);
          product.stock -= quantity;
          const expiresAt = new Date(Date.now() + reservationTtlMs(key));
          held.set(reserveKey, { localId, quantity, status: "HELD", expiresAt });
          return { reservationId: reserveKey, localId, quantity, expiresAt };
        },

    confirm: !reservations
      ? unsupported
      : async ({ reservationId }) => {
          const existing = held.get(reservationId);
          if (!existing || existing.status === "RELEASED") throw new ReservationExpiredError(reservationId);
          existing.status = "CONFIRMED";
        },

    release: !reservations
      ? unsupported
      : async ({ reservationId }) => {
          const existing = held.get(reservationId);
          if (!existing || existing.status !== "HELD") return;
          existing.status = "RELEASED";
          const product = products.get(existing.localId);
          if (product) product.stock += existing.quantity;
        },
  };
};

// Writes contract products in the memory source's own shape.
export const seedMemorySource = (source: MemorySource, items: ContractProduct[]) => {
  for (const item of items) {
    source.products.set(item.localId, {
      localId: item.localId,
      nativeCategory: NATIVE_CATEGORIES[item.category],
      stock: item.available,
      updatedAt: item.updatedAt ?? new Date(),
    });
  }
};

export const memoryHarness = (source: MemorySource, served: CatalogSource = source): ContractHarness => ({
  source: served,
  seed: async (items) => seedMemorySource(source, items),
  cleanup: async () => {
    source.products.clear();
    source.reservations.clear();
  },
});
