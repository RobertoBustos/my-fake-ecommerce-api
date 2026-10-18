import { describe, it, expect } from "vitest";
import { OutOfStockError } from "../../src/catalog/ports.js";
import { contractChecks, describeCatalogSourceContract } from "./catalogSource.contract.js";
import { createMemorySource, memoryHarness } from "./memorySource.js";

// The suite itself under test: the in-memory reference adapter passes every
// check, and an adapter that breaks one rule fails the check for that rule.

describeCatalogSourceContract("in-memory reference adapter", async () => memoryHarness(createMemorySource()));

describeCatalogSourceContract("in-memory source without change tracking", async () =>
  memoryHarness(createMemorySource({ key: "mem-untracked", tracksChanges: false }))
);

const check = (name) => {
  const found = contractChecks.find((c) => c.name.startsWith(name));
  if (!found) throw new Error(`No contract check starts with "${name}"`);
  return found;
};

// Each broken adapter is the reference with one rule broken.
const brokenAdapters = [
  {
    rule: "getProducts returns the source's products in the shared shape",
    breakIt: (source) => ({
      ...source,
      getProducts: async (ids) =>
        (await source.getProducts(ids)).map((product) => ({ ...product, unitPrice: 15.5 })),
    }),
  },
  {
    rule: "getProducts skips ids the source doesn't have",
    breakIt: (source) => ({
      ...source,
      getProducts: async (ids) => {
        if (ids.some((id) => !source.products.has(id))) throw new Error("product not found");
        return source.getProducts(ids);
      },
    }),
  },
  {
    rule: "categories come back mapped",
    breakIt: (source) => ({
      ...source,
      getProducts: async (ids) =>
        ids.flatMap((id) => {
          const stored = source.products.get(id);
          return stored ? [{ ...source.toSourceProduct(stored), category: stored.nativeCategory }] : [];
        }),
    }),
  },
  {
    rule: "listChanged pages through every product exactly once",
    breakIt: (source) => ({
      ...source,
      listChanged: (since, { limit }) => source.listChanged(since, { limit }),
    }),
  },
  {
    rule: "listChanged(since) returns what changed after since",
    breakIt: (source) => ({
      ...source,
      listChanged: (_since, page) => source.listChanged(null, page),
    }),
  },
  {
    rule: "reserve sets the units aside until the source's TTL",
    breakIt: (source) => ({
      ...source,
      reserve: async (...args) => ({ ...(await source.reserve(...args)), expiresAt: null }),
    }),
  },
  {
    rule: "reserve follows RESERVATION_TTL_MINUTES_<KEY>",
    breakIt: (source) => ({
      ...source,
      reserve: async (...args) => ({
        ...(await source.reserve(...args)),
        expiresAt: new Date(Date.now() + 60 * 60_000),
      }),
    }),
  },
  {
    rule: "reserve with the same key",
    breakIt: (source) => ({
      ...source,
      reserve: async (localId, quantity, key) => {
        source.reservations.delete(key);
        return source.reserve(localId, quantity, key);
      },
    }),
  },
  {
    rule: "reserve throws OutOfStockError",
    breakIt: (source) => ({
      ...source,
      reserve: async (localId, quantity, key) => {
        try {
          return await source.reserve(localId, quantity, key);
        } catch (err) {
          if (!(err instanceof OutOfStockError)) throw err;
          return { reservationId: key, localId, quantity, expiresAt: new Date() };
        }
      },
    }),
  },
  {
    rule: "confirm marks the units sold",
    breakIt: (source) => ({ ...source, confirm: async () => {} }),
  },
  {
    rule: "release puts the units back once",
    breakIt: (source) => ({
      ...source,
      release: async (reservation) => {
        const product = source.products.get(reservation.localId);
        if (product) product.stock += reservation.quantity;
      },
    }),
  },
  {
    rule: "confirm throws ReservationExpiredError",
    breakIt: (source) => ({
      ...source,
      confirm: async (reservation, key) => {
        if (source.reservations.get(reservation.reservationId)?.status === "HELD") {
          await source.confirm(reservation, key);
        }
      },
    }),
  },
];

describe("CatalogSource contract catches a broken adapter", () => {
  it("has a broken adapter for every check", () => {
    for (const { name } of contractChecks) {
      expect(
        brokenAdapters.some(({ rule }) => name.startsWith(rule)),
        `no broken adapter for "${name}"`
      ).toBe(true);
    }
  });

  for (const { rule, breakIt } of brokenAdapters) {
    it(`fails "${rule}"`, async () => {
      const source = createMemorySource();
      const harness = memoryHarness(source, breakIt(source));
      await expect(check(rule).run(harness)).rejects.toThrow();
    });
  }
});
