import { describe, it, expect } from "vitest";
import { createMemorySearchIndex } from "../../src/search/adapters/memory.js";
import { describeSearchIndexContract, searchContractChecks } from "./searchIndex.contract.js";

// The suite itself under test: the in-memory index passes every check, and an
// index that breaks one rule fails the check for that rule.

describeSearchIndexContract("in-memory index", async () => ({
  index: createMemorySearchIndex(),
  cleanup: async () => {},
}));

const check = (name) => {
  const found = searchContractChecks.find((c) => c.name.startsWith(name));
  if (!found) throw new Error(`No search contract check starts with "${name}"`);
  return found;
};

const stripQuotes = (query) => ({ ...query, text: query.text.replace(/"/g, "") });

// Each broken index is the in-memory one with one rule broken.
const brokenIndexes = [
  {
    rule: "upsert makes documents searchable",
    breakIt: (index) => {
      const seen = new Set();
      return {
        ...index,
        // Appends instead of replacing: a repeated upsert counts twice.
        upsert: async (docs) => {
          await index.upsert(docs.map((doc) => (seen.has(doc.id) ? { ...doc, id: `${doc.id}-again` } : doc)));
          docs.forEach((doc) => seen.add(doc.id));
        },
      };
    },
  },
  {
    rule: "upsert of an existing id replaces",
    breakIt: (index) => {
      const known = new Set();
      return {
        ...index,
        replaceAll: async (docs) => {
          docs.forEach((doc) => known.add(doc.id));
          await index.replaceAll(docs);
        },
        upsert: async (docs) => index.upsert(docs.filter((doc) => !known.has(doc.id))),
      };
    },
  },
  {
    rule: "delete removes documents",
    breakIt: (index) => ({
      ...index,
      // Drops a batch of several ids, as if the unknown one failed it.
      delete: async (ids) => {
        const { total } = await index.search({ text: "" });
        if (ids.length > 1 && total > 0) return;
        await index.delete(ids);
      },
    }),
  },
  {
    rule: "replaceAll leaves exactly the new documents",
    breakIt: (index) => ({
      ...index,
      // Clears first and fills later: searches see an empty index meanwhile.
      replaceAll: async (docs) => {
        await index.replaceAll([]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await index.upsert(docs);
      },
    }),
  },
  {
    rule: "filters by category, price range, stock and source",
    breakIt: (index) => ({
      ...index,
      search: (query) => index.search({ ...query, filters: { ...query.filters, sourceKeys: undefined } }),
    }),
  },
  {
    rule: "an empty text matches",
    breakIt: (index) => ({
      ...index,
      search: async (query) => (query.text ? index.search(query) : { ids: [], total: 0, facets: [] }),
    }),
  },
  {
    rule: "sorts by price",
    breakIt: (index) => ({ ...index, search: (query) => index.search({ ...query, sort: "PRICE_ASC" }) }),
  },
  {
    rule: "pages through results",
    breakIt: (index) => ({
      ...index,
      search: async (query) => {
        const result = await index.search({ ...query, page: { offset: 0, limit: 50 } });
        const { limit } = query.page ?? { limit: 20 };
        return { ...result, ids: result.ids.slice(0, limit) };
      },
    }),
  },
  {
    rule: "facet counts are exact",
    breakIt: (index) => ({
      ...index,
      // Counts only the returned page.
      search: async (query) => {
        const result = await index.search(query);
        return {
          ...result,
          facets: result.facets.map((facet) => ({
            ...facet,
            values: facet.values.map((v) => ({ ...v, count: Math.min(v.count, result.ids.length) })),
          })),
        };
      },
    }),
  },
  {
    rule: 'a "quoted phrase" matches',
    breakIt: (index) => ({ ...index, search: (query) => index.search(stripQuotes(query)) }),
  },
  {
    rule: "every word of the query must match",
    breakIt: (index) => ({
      ...index,
      search: (query) => index.search({ ...query, text: query.text.split(" ").slice(0, 1).join(" ") }),
    }),
  },
  {
    rule: "a word with a typo",
    breakIt: (index) => ({
      ...index,
      search: async (query) => (query.text === "jaket" ? { ids: [], total: 0, facets: [] } : index.search(query)),
    }),
  },
  {
    rule: "the last word works as a prefix",
    breakIt: (index) => ({
      ...index,
      search: async (query) => (query.text === "jac" ? { ids: [], total: 0, facets: [] } : index.search(query)),
    }),
  },
  {
    rule: "the 20 spike queries",
    // An engine without typo tolerance or prefixes, like Firestore
    // Enterprise in the spike.
    breakIt: (index) => ({
      ...index,
      search: async (query) =>
        /^(jaket|monitr|braclet|jac|mon|backpak|neckl)$/.test(query.text)
          ? { ids: [], total: 0, facets: [] }
          : index.search(query),
    }),
  },
];

describe("SearchIndex contract catches a broken index", () => {
  it("has a broken index for every check", () => {
    for (const { name } of searchContractChecks) {
      expect(
        brokenIndexes.some(({ rule }) => name.startsWith(rule)),
        `no broken index for "${name}"`,
      ).toBe(true);
    }
  });

  for (const { rule, breakIt } of brokenIndexes) {
    it(`fails "${rule}"`, async () => {
      const harness = { index: breakIt(createMemorySearchIndex()), cleanup: async () => {} };
      await expect(check(rule).run(harness)).rejects.toThrow(/expected|AssertionError/i);
    }, 30_000);
  }
});
