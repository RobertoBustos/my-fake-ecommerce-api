import { randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isCatalogCategory, type CatalogCategory } from "../../src/catalog/categories.js";
import {
  OutOfStockError,
  ReservationExpiredError,
  type CatalogSource,
  type Reservation,
  type SourceProduct,
} from "../../src/catalog/ports.js";
import { reservationTtlMs } from "../../src/catalog/reservationTtl.js";

// The behaviour the purchase flow relies on from every catalog source. A new
// adapter passes this suite before it is registered:
//
//   describeCatalogSourceContract("my source", async () => harness);
//
// The harness gives the suite the source exactly as the registry serves it
// (wrapped with withCoreReservations when it can't reserve) and a way to put
// products into the source's own store.

export interface ContractProduct {
  localId: string;
  // The shared category the product must come back with; the harness stores
  // it under the source's own name for it.
  category: CatalogCategory;
  available: number;
  // Sources that don't track changes ignore it.
  updatedAt?: Date;
}

export interface ContractHarness {
  source: CatalogSource;
  // Writes the products into the source's store, replacing any with the same id.
  seed(products: ContractProduct[]): Promise<void>;
  // Removes what seed and the checks created.
  cleanup(): Promise<void>;
}

export interface ContractCheck {
  name: string;
  run(harness: ContractHarness): Promise<void>;
}

const newId = () => `contract-${randomUUID()}`;
const newKey = () => `contract-${randomUUID()}-reserve`;

const seedOne = async (harness: ContractHarness, available: number, overrides: Partial<ContractProduct> = {}) => {
  const product: ContractProduct = { localId: newId(), category: "electronics", available, ...overrides };
  await harness.seed([product]);
  return product.localId;
};

const productOf = async (source: CatalogSource, localId: string): Promise<SourceProduct> => {
  const [product] = await source.getProducts([localId]);
  expect(product, `getProducts should find ${localId}`).toBeDefined();
  return product;
};

const availableOf = async (source: CatalogSource, localId: string) =>
  (await productOf(source, localId)).available;

// A source that keeps its own reservations takes the units out of its
// stock; with core reservations the source's stock never moves.
const takesUnits = (source: CatalogSource) => source.capabilities.reservations;

// Every page of listChanged from the start, failing on a source whose
// cursor never ends instead of looping forever.
const listAll = async (source: CatalogSource, since: Date | null, limit: number) => {
  const pages: SourceProduct[][] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const page = await source.listChanged(since, { cursor, limit });
    expect(page.items.length, "a page has at most `limit` items").toBeLessThanOrEqual(limit);
    expect(Array.isArray(page.deletedIds)).toBe(true);
    pages.push(page.items);
    if (!page.nextCursor) return pages;
    expect(page.nextCursor, "the cursor moves forward").not.toBe(cursor);
    cursor = page.nextCursor;
  }
  throw new Error("listChanged returned a cursor on 1000 pages in a row");
};

export const contractChecks: ContractCheck[] = [
  {
    name: "getProducts returns the source's products in the shared shape",
    async run(harness) {
      const localId = await seedOne(harness, 7);
      const product = await productOf(harness.source, localId);
      expect(product.localId).toBe(localId);
      expect(typeof product.title).toBe("string");
      expect(typeof product.description).toBe("string");
      expect(typeof product.image).toBe("string");
      expect(product.currency).toMatch(/^[A-Z]{3}$/);
      expect(Number.isInteger(product.unitPrice) && product.unitPrice >= 0, "unitPrice is whole cents").toBe(true);
      expect(product.purchaseLimits.min).toBeGreaterThanOrEqual(1);
      expect(product.purchaseLimits.max).toBeGreaterThanOrEqual(product.purchaseLimits.min);
      expect(product.available).toBe(7);
      expect(product.updatedAt === null || product.updatedAt instanceof Date).toBe(true);
    },
  },
  {
    name: "getProducts skips ids the source doesn't have instead of failing",
    async run(harness) {
      const localId = await seedOne(harness, 1);
      const products = await harness.source.getProducts([newId(), localId, newId()]);
      expect(products.map((p) => p.localId)).toEqual([localId]);
      expect(await harness.source.getProducts([])).toEqual([]);
    },
  },
  {
    name: "categories come back mapped to the shared taxonomy",
    async run(harness) {
      const products: ContractProduct[] = (["electronics", "jewelery", "men's clothing", "women's clothing"] as const).map(
        (category) => ({ localId: newId(), category, available: 1 })
      );
      await harness.seed(products);
      const found = await harness.source.getProducts(products.map((p) => p.localId));
      for (const expected of products) {
        const product = found.find((p) => p.localId === expected.localId);
        expect(product?.category, `category of ${expected.localId}`).toBe(expected.category);
        expect(isCatalogCategory(product!.category)).toBe(true);
      }
    },
  },
  {
    name: "listChanged pages through every product exactly once",
    async run(harness) {
      const seeded = [newId(), newId(), newId(), newId(), newId()];
      await harness.seed(seeded.map((localId) => ({ localId, category: "electronics", available: 1 })));
      const ids = (await listAll(harness.source, null, 2)).flat().map((p) => p.localId);
      expect(new Set(ids).size, "no product appears on two pages").toBe(ids.length);
      for (const localId of seeded) expect(ids).toContain(localId);
    },
  },
  {
    name: "listChanged(since) returns what changed after since, or everything when the source doesn't track changes",
    async run(harness) {
      const old = { localId: newId(), category: "electronics" as const, available: 1, updatedAt: new Date("2026-01-01T00:00:00Z") };
      const changed = { localId: newId(), category: "electronics" as const, available: 1, updatedAt: new Date("2026-03-01T00:00:00Z") };
      await harness.seed([old, changed]);
      const ids = (await listAll(harness.source, new Date("2026-02-01T00:00:00Z"), 50)).flat().map((p) => p.localId);
      expect(ids).toContain(changed.localId);
      const tracked = (await productOf(harness.source, old.localId)).updatedAt;
      if (tracked === null) {
        // Without updatedAt a sync can't tell what changed: it gets everything.
        expect(ids).toContain(old.localId);
      } else {
        expect(tracked.getTime()).toBe(old.updatedAt.getTime());
        expect(ids).not.toContain(old.localId);
      }
    },
  },
  {
    name: "reserve sets the units aside until the source's TTL",
    async run(harness) {
      const { source } = harness;
      const localId = await seedOne(harness, 5);
      const before = Date.now();
      const reservation = await source.reserve(localId, 2, newKey());
      const after = Date.now();
      expect(reservation).toMatchObject({ localId, quantity: 2 });
      expect(typeof reservation.reservationId).toBe("string");
      expect(reservation.expiresAt).toBeInstanceOf(Date);
      const ttl = reservationTtlMs(source.key);
      expect(reservation.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + ttl - 1000);
      expect(reservation.expiresAt!.getTime()).toBeLessThanOrEqual(after + ttl + 1000);
      if (takesUnits(source)) expect(await availableOf(source, localId)).toBe(3);
    },
  },
  {
    name: "reserve follows RESERVATION_TTL_MINUTES_<KEY>",
    async run(harness) {
      const { source } = harness;
      const name = `RESERVATION_TTL_MINUTES_${source.key.toUpperCase().replace(/-/g, "_")}`;
      const original = process.env[name];
      process.env[name] = "5";
      try {
        const localId = await seedOne(harness, 1);
        const before = Date.now();
        const reservation = await source.reserve(localId, 1, newKey());
        const minutes = (reservation.expiresAt!.getTime() - before) / 60_000;
        expect(minutes).toBeGreaterThan(4.9);
        expect(minutes).toBeLessThan(5.1);
      } finally {
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
      }
    },
  },
  {
    name: "reserve with the same key returns the same reservation and takes the units once",
    async run(harness) {
      const { source } = harness;
      const localId = await seedOne(harness, 5);
      const key = newKey();
      const first = await source.reserve(localId, 2, key);
      const again = await source.reserve(localId, 2, key);
      expect(again.reservationId).toBe(first.reservationId);
      expect(again.quantity).toBe(2);
      expect(again.expiresAt?.getTime()).toBe(first.expiresAt?.getTime());
      if (takesUnits(source)) expect(await availableOf(source, localId)).toBe(3);
    },
  },
  {
    name: "reserve throws OutOfStockError, taking nothing, when the units aren't there",
    async run(harness) {
      const { source } = harness;
      const localId = await seedOne(harness, 2);
      await expect(source.reserve(localId, 3, newKey())).rejects.toBeInstanceOf(OutOfStockError);
      await expect(source.reserve(newId(), 1, newKey())).rejects.toBeInstanceOf(OutOfStockError);
      expect(await availableOf(source, localId)).toBe(2);
      // The failed call left nothing behind: the full quantity is still there.
      await source.reserve(localId, 2, newKey());
    },
  },
  {
    name: "confirm marks the units sold, once, and a later release doesn't put them back",
    async run(harness) {
      const { source } = harness;
      const localId = await seedOne(harness, 5);
      const reservation = await source.reserve(localId, 2, newKey());
      await source.confirm(reservation, `${reservation.reservationId}-confirm`);
      await source.confirm(reservation, `${reservation.reservationId}-confirm`);
      await source.release(reservation, `${reservation.reservationId}-release`);
      expect(await availableOf(source, localId)).toBe(takesUnits(source) ? 3 : 5);
    },
  },
  {
    name: "release puts the units back once, however many times it runs",
    async run(harness) {
      const { source } = harness;
      const localId = await seedOne(harness, 5);
      const reservation = await source.reserve(localId, 2, newKey());
      await source.release(reservation, `${reservation.reservationId}-release`);
      await source.release(reservation, `${reservation.reservationId}-release`);
      expect(await availableOf(source, localId)).toBe(5);
    },
  },
  {
    name: "confirm throws ReservationExpiredError for a released or unknown reservation",
    async run(harness) {
      const { source } = harness;
      const localId = await seedOne(harness, 5);
      const reservation = await source.reserve(localId, 1, newKey());
      await source.release(reservation, `${reservation.reservationId}-release`);
      await expect(source.confirm(reservation, `${reservation.reservationId}-confirm`)).rejects.toBeInstanceOf(
        ReservationExpiredError
      );
      const unknown: Reservation = { reservationId: newKey(), localId, quantity: 1, expiresAt: new Date() };
      await expect(source.confirm(unknown, `${unknown.reservationId}-confirm`)).rejects.toBeInstanceOf(
        ReservationExpiredError
      );
      expect(await availableOf(source, localId)).toBe(5);
    },
  },
];

// Registers every check as a test against the source the factory builds.
export const describeCatalogSourceContract = (
  name: string,
  createHarness: () => Promise<ContractHarness>
) => {
  describe(`CatalogSource contract: ${name}`, () => {
    let harness: ContractHarness;
    beforeAll(async () => {
      harness = await createHarness();
    });
    afterAll(async () => {
      await harness?.cleanup();
    });
    for (const check of contractChecks) {
      it(check.name, () => check.run(harness));
    }
  });
};
