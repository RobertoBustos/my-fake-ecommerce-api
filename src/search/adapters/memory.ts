import type { Facet, SearchDoc, SearchIndex, SearchQuery, SearchResult } from "../ports.js";

// An in-memory search index for tests and local runs (SEARCH_ENGINE=memory).
// It follows the same rules a hosted engine applies by default, kept simple:
// it is a reference for the contract suite, not a production engine.
//
// - Text is lower-cased, without accents or possessive "'s", split into
//   words of letters and digits.
// - Every query word must match: exactly, with 1 typo from 4 letters or 2
//   from 8 (insert, delete, substitute or swap), or, for the last word, as a
//   prefix. A "quoted phrase" matches its words in a row, exactly.
// - Searchable attributes, most important first: title, category,
//   description.
// - Ranking breaks ties in order: fewer typos, words closer together, a more
//   important attribute, more exact words, then insertion order.

const ATTRIBUTES = ["title", "category", "description"] as const;

const normalize = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/'s\b/g, "");

const tokenize = (text: string) => normalize(text).match(/[a-z0-9]+/g) ?? [];

const allowedTypos = (word: string) => (word.length >= 8 ? 2 : word.length >= 4 ? 1 : 0);

// Optimal string alignment distance: insert, delete, substitute, swap.
const distance = (a: string, b: string) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
};

interface ParsedQuery {
  words: string[];
  phrases: string[][];
}

const parseQuery = (text: string): ParsedQuery => {
  const phrases: string[][] = [];
  const rest = text.replace(/"([^"]*)"/g, (_, phrase: string) => {
    const words = tokenize(phrase);
    if (words.length) phrases.push(words);
    return " ";
  });
  return { words: tokenize(rest), phrases };
};

interface IndexedDoc {
  doc: SearchDoc;
  order: number;
  // Words of each searchable attribute, in ATTRIBUTES order.
  fields: string[][];
}

interface WordMatch {
  typos: number;
  exact: boolean;
  attribute: number;
  position: number;
}

const matchWord = (word: string, fields: string[][], isLast: boolean): WordMatch | null => {
  let best: WordMatch | null = null;
  const consider = (match: WordMatch) => {
    if (
      !best ||
      match.typos < best.typos ||
      (match.typos === best.typos &&
        (match.attribute < best.attribute || (match.attribute === best.attribute && match.exact && !best.exact)))
    ) {
      best = match;
    }
  };
  fields.forEach((tokens, attribute) => {
    tokens.forEach((token, position) => {
      if (token === word) return consider({ typos: 0, exact: true, attribute, position });
      if (isLast && token.startsWith(word)) return consider({ typos: 0, exact: false, attribute, position });
      const max = allowedTypos(word);
      if (!max) return;
      let typos = distance(word, token);
      // The last word may also be a mistyped prefix ("monit" for "monitor").
      if (isLast && token.length > word.length) typos = Math.min(typos, distance(word, token.slice(0, word.length)));
      if (typos <= max) consider({ typos, exact: false, attribute, position });
    });
  });
  return best;
};

const matchPhrase = (phrase: string[], fields: string[][]): WordMatch | null => {
  for (let attribute = 0; attribute < fields.length; attribute++) {
    const tokens = fields[attribute];
    for (let position = 0; position + phrase.length <= tokens.length; position++) {
      if (phrase.every((word, i) => tokens[position + i] === word)) {
        return { typos: 0, exact: true, attribute, position };
      }
    }
  }
  return null;
};

interface Ranked {
  entry: IndexedDoc;
  typos: number;
  proximity: number;
  attribute: number;
  exact: number;
}

const rank = (entry: IndexedDoc, query: ParsedQuery): Ranked | null => {
  const matches: WordMatch[] = [];
  for (const phrase of query.phrases) {
    const match = matchPhrase(phrase, entry.fields);
    if (!match) return null;
    matches.push(match);
  }
  for (const [i, word] of query.words.entries()) {
    const match = matchWord(word, entry.fields, i === query.words.length - 1);
    if (!match) return null;
    matches.push(match);
  }
  let proximity = 0;
  for (const attribute of new Set(matches.map((m) => m.attribute))) {
    const positions = matches
      .filter((m) => m.attribute === attribute)
      .map((m) => m.position)
      .sort((a, b) => a - b);
    for (let i = 1; i < positions.length; i++) proximity += Math.min(positions[i] - positions[i - 1], 8);
  }
  return {
    entry,
    typos: matches.reduce((sum, m) => sum + m.typos, 0),
    proximity,
    attribute: matches.reduce((sum, m) => sum + m.attribute, 0),
    exact: matches.filter((m) => m.exact).length,
  };
};

const byRelevance = (a: Ranked, b: Ranked) =>
  a.typos - b.typos ||
  a.proximity - b.proximity ||
  a.attribute - b.attribute ||
  b.exact - a.exact ||
  a.entry.order - b.entry.order;

const passesFilters = ({ doc }: IndexedDoc, filters: SearchQuery["filters"] = {}) =>
  (filters.category === undefined || doc.category === filters.category) &&
  (filters.minPrice === undefined || (doc.settlementPrice !== null && doc.settlementPrice >= filters.minPrice)) &&
  (filters.maxPrice === undefined || (doc.settlementPrice !== null && doc.settlementPrice <= filters.maxPrice)) &&
  (filters.inStock === undefined || doc.inStock === filters.inStock) &&
  (filters.sourceKeys === undefined || filters.sourceKeys.includes(doc.sourceKey));

const index = (doc: SearchDoc, order: number): IndexedDoc => ({
  doc: { ...doc },
  order,
  fields: ATTRIBUTES.map((attribute) => tokenize(doc[attribute])),
});

export const createMemorySearchIndex = (): SearchIndex => {
  let docs = new Map<string, IndexedDoc>();
  let nextOrder = 0;

  return {
    key: "memory",

    async upsert(newDocs) {
      for (const doc of newDocs) {
        docs.set(doc.id, index(doc, docs.get(doc.id)?.order ?? nextOrder++));
      }
    },

    async delete(ids) {
      for (const id of ids) docs.delete(id);
    },

    async replaceAll(newDocs) {
      // Built aside and swapped in one step, so no search sees it half done.
      const next = new Map<string, IndexedDoc>();
      for (const doc of newDocs) next.set(doc.id, index(doc, nextOrder++));
      docs = next;
    },

    async search(query): Promise<SearchResult> {
      const parsed = parseQuery(query.text);
      const hits = [...docs.values()]
        .filter((entry) => passesFilters(entry, query.filters))
        .flatMap((entry) => rank(entry, parsed) ?? [])
        .sort(byRelevance);

      const sort = query.sort ?? "RELEVANCE";
      if (sort !== "RELEVANCE") {
        const direction = sort === "PRICE_ASC" ? 1 : -1;
        // Array.prototype.sort is stable: equal prices keep relevance order.
        // Documents without a price go last in both directions.
        hits.sort((a, b) => {
          const [pa, pb] = [a.entry.doc.settlementPrice, b.entry.doc.settlementPrice];
          if (pa === null || pb === null) return (pa === null ? 1 : 0) - (pb === null ? 1 : 0);
          return direction * (pa - pb);
        });
      }

      const facets: Facet[] = (query.facets ?? []).map((name) => {
        const counts = new Map<string, number>();
        for (const { entry } of hits) counts.set(entry.doc[name], (counts.get(entry.doc[name]) ?? 0) + 1);
        return {
          name,
          values: [...counts]
            .map(([value, count]) => ({ value, count }))
            .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
        };
      });

      const { offset = 0, limit = 20 } = query.page ?? {};
      return {
        ids: hits.slice(offset, offset + limit).map(({ entry }) => entry.doc.id),
        total: hits.length,
        facets,
      };
    },
  };
};
