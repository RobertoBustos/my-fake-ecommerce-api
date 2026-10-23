import { randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SearchDoc, SearchIndex, SearchQuery } from "../../src/search/ports.js";
import { buildDataset, QUERIES, toSearchDoc, toSearchQuery, type SpikeQuery } from "./searchFixtures.js";

// The behaviour searchProducts relies on from every search engine. A new
// adapter passes this suite before SEARCH_ENGINE can name it:
//
//   describeSearchIndexContract("my engine", async () => harness);
//
// Two levels:
// - exact rules every adapter meets: writes, filters, paging, facets, price
//   order and phrases;
// - relevance, what a shopper notices: typos, prefixes and the 20 queries of
//   the engine spike, with a minimum of relevant products in the top 3.
//
// The checks own the index they get: each one starts with replaceAll, so a
// harness must hand over an index nothing else uses (a test index on a
// hosted engine).

export interface SearchContractHarness {
  index: SearchIndex;
  // Removes what the checks created.
  cleanup(): Promise<void>;
}

export interface SearchContractCheck {
  name: string;
  run(harness: SearchContractHarness): Promise<void>;
}

let counter = 0;
const doc = (overrides: Partial<SearchDoc> = {}): SearchDoc => ({
  id: `contract-${randomUUID()}`,
  sourceKey: "fs",
  title: `Contract fixture ${++counter}`,
  description: "",
  category: "electronics",
  settlementPrice: 1000,
  inStock: true,
  ...overrides,
});

const search = (harness: SearchContractHarness, query: Partial<SearchQuery> & { text: string }) =>
  harness.index.search({ page: { offset: 0, limit: 50 }, ...query });

const idsOf = async (harness: SearchContractHarness, query: Partial<SearchQuery> & { text: string }) =>
  (await search(harness, query)).ids;

// Products every exact rule runs against. The titles share no word with the
// spike catalog, so a stray document can't satisfy a check by accident.
const exactFixtures = () => {
  const laptop = doc({ title: "Zephyr laptop sleeve", category: "electronics", settlementPrice: 4500 });
  const phone = doc({ title: "Zephyr phone stand", category: "electronics", settlementPrice: 1200, inStock: false });
  const ring = doc({ title: "Zephyr silver ring", category: "jewelery", settlementPrice: 9900 });
  const scarf = doc({
    title: "Zephyr wool scarf",
    description: "Hand knitted in warm wool",
    category: "women's clothing",
    settlementPrice: 2500,
    sourceKey: "other",
  });
  return { laptop, phone, ring, scarf, all: [laptop, phone, ring, scarf] };
};

export const exactChecks: SearchContractCheck[] = [
  {
    name: "upsert makes documents searchable and repeating it changes nothing",
    async run(harness) {
      const { all, laptop } = exactFixtures();
      await harness.index.replaceAll([]);
      await harness.index.upsert(all);
      await harness.index.upsert(all);
      const result = await search(harness, { text: "zephyr" });
      expect(result.total).toBe(4);
      expect(new Set(result.ids)).toEqual(new Set(all.map((d) => d.id)));
      expect(await idsOf(harness, { text: "laptop" })).toEqual([laptop.id]);
    },
  },
  {
    name: "upsert of an existing id replaces the document",
    async run(harness) {
      const { all, laptop } = exactFixtures();
      await harness.index.replaceAll(all);
      await harness.index.upsert([{ ...laptop, title: "Zephyr tablet sleeve", settlementPrice: 99_000 }]);
      expect(await idsOf(harness, { text: "laptop" })).toEqual([]);
      expect(await idsOf(harness, { text: "tablet" })).toEqual([laptop.id]);
      expect(await idsOf(harness, { text: "zephyr", filters: { minPrice: 50_000 } })).toEqual([laptop.id]);
      expect((await search(harness, { text: "zephyr" })).total).toBe(4);
    },
  },
  {
    name: "delete removes documents from results and ignores unknown ids",
    async run(harness) {
      const { all, ring } = exactFixtures();
      await harness.index.replaceAll(all);
      await harness.index.delete([ring.id, `contract-${randomUUID()}`]);
      const result = await search(harness, { text: "zephyr" });
      expect(result.ids).not.toContain(ring.id);
      expect(result.total).toBe(3);
      expect(await idsOf(harness, { text: "ring" })).toEqual([]);
    },
  },
  {
    name: "replaceAll leaves exactly the new documents, with no empty window while it runs",
    async run(harness) {
      const { all } = exactFixtures();
      await harness.index.replaceAll(all);
      const next = [doc({ title: "Zephyr desk lamp" }), doc({ title: "Zephyr desk fan" })];
      const replacing = harness.index.replaceAll(next);
      const during = await search(harness, { text: "zephyr" });
      await replacing;
      // Mid-swap a search answers from the old or the new contents, never
      // from neither.
      expect(during.total).toBeGreaterThan(0);
      const after = await search(harness, { text: "zephyr" });
      expect(new Set(after.ids)).toEqual(new Set(next.map((d) => d.id)));
      expect(after.total).toBe(2);
    },
  },
  {
    name: "filters by category, price range, stock and source",
    async run(harness) {
      const { all, laptop, phone, ring, scarf } = exactFixtures();
      await harness.index.replaceAll(all);
      const ids = (filters: SearchQuery["filters"]) => idsOf(harness, { text: "zephyr", filters });
      expect(new Set(await ids({ category: "electronics" }))).toEqual(new Set([laptop.id, phone.id]));
      // Both ends of the price range are inclusive.
      expect(new Set(await ids({ minPrice: 2500, maxPrice: 9900 }))).toEqual(new Set([laptop.id, ring.id, scarf.id]));
      expect(await ids({ maxPrice: 1199 })).toEqual([]);
      expect(await ids({ inStock: false })).toEqual([phone.id]);
      expect(await ids({ sourceKeys: ["other"] })).toEqual([scarf.id]);
      expect(await ids({ sourceKeys: [] })).toEqual([]);
      expect(new Set(await ids({ category: "electronics", inStock: true }))).toEqual(new Set([laptop.id]));
    },
  },
  {
    name: "an empty text matches every document that passes the filters",
    async run(harness) {
      const { all, laptop, phone } = exactFixtures();
      await harness.index.replaceAll(all);
      expect((await search(harness, { text: "" })).total).toBe(4);
      expect(new Set(await idsOf(harness, { text: "", filters: { category: "electronics" } }))).toEqual(
        new Set([laptop.id, phone.id]),
      );
    },
  },
  {
    name: "sorts by price in both directions",
    async run(harness) {
      const { all, laptop, phone, ring, scarf } = exactFixtures();
      await harness.index.replaceAll(all);
      expect(await idsOf(harness, { text: "zephyr", sort: "PRICE_ASC" })).toEqual([
        phone.id,
        scarf.id,
        laptop.id,
        ring.id,
      ]);
      expect(await idsOf(harness, { text: "zephyr", sort: "PRICE_DESC" })).toEqual([
        ring.id,
        laptop.id,
        scarf.id,
        phone.id,
      ]);
    },
  },
  {
    name: "pages through results in a stable order, each id once",
    async run(harness) {
      const docs = Array.from({ length: 7 }, (_, i) => doc({ title: `Zephyr widget ${i}`, settlementPrice: 1000 + i }));
      await harness.index.replaceAll(docs);
      for (const sort of ["RELEVANCE", "PRICE_ASC"] as const) {
        const whole = await idsOf(harness, { text: "zephyr widget", sort });
        const pages: string[] = [];
        for (let offset = 0; offset < 9; offset += 3) {
          const page = await search(harness, { text: "zephyr widget", sort, page: { offset, limit: 3 } });
          expect(page.total).toBe(7);
          pages.push(...page.ids);
        }
        expect(pages).toEqual(whole);
        expect(new Set(pages).size).toBe(7);
      }
    },
  },
  {
    name: "facet counts are exact over every match of the query and its filters",
    async run(harness) {
      const { all } = exactFixtures();
      await harness.index.replaceAll(all);
      const result = await harness.index.search({
        text: "zephyr",
        page: { offset: 0, limit: 1 },
        facets: ["category"],
      });
      expect(result.ids).toHaveLength(1);
      expect(result.facets).toEqual([
        {
          name: "category",
          values: expect.arrayContaining([
            { value: "electronics", count: 2 },
            { value: "jewelery", count: 1 },
            { value: "women's clothing", count: 1 },
          ]),
        },
      ]);
      expect(result.facets[0].values).toHaveLength(3);
      expect(result.facets[0].values[0]).toEqual({ value: "electronics", count: 2 });
      const filtered = await harness.index.search({ text: "zephyr", filters: { inStock: true }, facets: ["category"] });
      const electronics = filtered.facets[0].values.find((v) => v.value === "electronics");
      expect(electronics?.count).toBe(1);
      expect((await harness.index.search({ text: "zephyr" })).facets).toEqual([]);
    },
  },
  {
    name: 'a "quoted phrase" matches its words in a row, exactly',
    async run(harness) {
      const { all, scarf } = exactFixtures();
      await harness.index.replaceAll(all);
      expect(await idsOf(harness, { text: '"warm wool"' })).toEqual([scarf.id]);
      expect(await idsOf(harness, { text: '"wool warm"' })).toEqual([]);
      // No typos inside a phrase.
      expect(await idsOf(harness, { text: '"warm wol"' })).toEqual([]);
    },
  },
  {
    name: "every word of the query must match",
    async run(harness) {
      const { all, ring } = exactFixtures();
      await harness.index.replaceAll(all);
      expect(await idsOf(harness, { text: "zephyr silver ring" })).toEqual([ring.id]);
      expect(await idsOf(harness, { text: "zephyr golden ring" })).toEqual([]);
    },
  },
];

// ---------- relevance ----------

// The spike catalog, indexed once for every relevance check.
const dataset = buildDataset();
const byId = new Map(dataset.map((p) => [p.id, p]));

const relevantInTop3 = async (harness: SearchContractHarness, q: SpikeQuery) => {
  const { ids } = await harness.index.search(toSearchQuery(q));
  const expected = Math.min(3, dataset.filter(q.relevant).length);
  const hits = ids.filter((id) => byId.has(id) && q.relevant(byId.get(id)!)).length;
  return { ids, hits, expected };
};

const loadDataset = (harness: SearchContractHarness) => harness.index.replaceAll(dataset.map(toSearchDoc));

const query = (id: string) => QUERIES.find((q) => q.id === id)!;

// The minimum share of the expected relevant products that must be in the
// top 3, over all 20 queries and over the 8 typo and prefix ones. Measured
// this way, the in-memory index gets every one; in the spike Firestore
// Enterprise found none for "jaket", "monitr", "braclet", "jac" or "mon",
// about a third of the typo and prefix share, which this rejects.
export const RELEVANCE_THRESHOLDS = { overall: 0.9, typosAndPrefixes: 0.9 };

export const relevanceChecks: SearchContractCheck[] = [
  {
    name: 'a word with a typo finds the right products ("jaket" finds jackets)',
    async run(harness) {
      await loadDataset(harness);
      for (const id of ["q03", "q04", "q06"]) {
        const { hits, expected, ids } = await relevantInTop3(harness, query(id));
        expect(hits, `"${query(id).text}" top 3: ${ids.join(", ")}`).toBe(expected);
      }
    },
  },
  {
    name: 'the last word works as a prefix ("jac" finds jackets)',
    async run(harness) {
      await loadDataset(harness);
      for (const id of ["q08", "q09", "q10"]) {
        const { hits, expected, ids } = await relevantInTop3(harness, query(id));
        expect(hits, `"${query(id).text}" top 3: ${ids.join(", ")}`).toBe(expected);
      }
    },
  },
  {
    name: "the 20 spike queries put enough relevant products in the top 3",
    async run(harness) {
      await loadDataset(harness);
      let hits = 0;
      let expected = 0;
      let fuzzyHits = 0;
      let fuzzyExpected = 0;
      const misses: string[] = [];
      for (const q of QUERIES) {
        const result = await relevantInTop3(harness, q);
        hits += result.hits;
        expected += result.expected;
        if (q.group === "typo" || q.group === "prefix") {
          fuzzyHits += result.hits;
          fuzzyExpected += result.expected;
        }
        if (result.hits < result.expected) misses.push(`"${q.text}" ${result.hits}/${result.expected}`);
      }
      const report = `${hits}/${expected} overall, ${fuzzyHits}/${fuzzyExpected} on typos and prefixes; misses: ${misses.join(", ") || "none"}`;
      expect(hits / expected, report).toBeGreaterThanOrEqual(RELEVANCE_THRESHOLDS.overall);
      expect(fuzzyHits / fuzzyExpected, report).toBeGreaterThanOrEqual(RELEVANCE_THRESHOLDS.typosAndPrefixes);
    },
  },
];

export const searchContractChecks = [...exactChecks, ...relevanceChecks];

// Registers every check as a test against the index the factory builds.
export const describeSearchIndexContract = (name: string, createHarness: () => Promise<SearchContractHarness>) => {
  describe(`SearchIndex contract: ${name}`, () => {
    let harness: SearchContractHarness;
    beforeAll(async () => {
      harness = await createHarness();
    });
    afterAll(async () => {
      await harness?.cleanup();
    });
    describe("exact rules", () => {
      for (const check of exactChecks) it(check.name, () => check.run(harness));
    });
    describe("relevance", () => {
      for (const check of relevanceChecks) it(check.name, () => check.run(harness), 30_000);
    });
  });
};
