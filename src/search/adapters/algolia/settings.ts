import type { IndexSettings } from "algoliasearch";
import type { SearchSort } from "../../ports.js";

// The Algolia index settings, as code: scripts/configureSearchIndex.ts applies
// them (npm run search:configure), and the dashboard is never edited by hand.
// Each value is what makes one rule of the SearchIndex contract hold.

// Algolia's default ranking criteria; a price replica puts its sort first.
const RANKING = ["typo", "geo", "words", "filters", "proximity", "attribute", "exact", "custom"];

const shared: IndexSettings = {
  // Most important first. Category is searchable so "rain jacket women"
  // matches a jacket whose only "women" is its category.
  searchableAttributes: ["title", "category", "unordered(description)"],
  attributesForFaceting: ["category", "filterOnly(sourceKey)", "filterOnly(inStock)"],
  // Among equally relevant products, the ones in stock first.
  customRanking: ["desc(inStock)"],
  // The contract's typo and prefix rules, stated even where they are the
  // default so a change in Algolia's defaults doesn't change them.
  minWordSizefor1Typo: 4,
  minWordSizefor2Typos: 8,
  queryType: "prefixLast",
  removeWordsIfNoResults: "none",
  // "Quoted phrases" only: a leading "-" stays a normal character instead of
  // excluding a word.
  advancedSyntax: true,
  advancedSyntaxFeatures: ["exactPhrase"],
  // The API only reads ids, so nothing is highlighted or snippeted.
  attributesToHighlight: [],
  attributesToSnippet: [],
  // Algolia's maximum, so every category comes back in a facet.
  maxValuesPerFacet: 1000,
};

// Standard replicas, not virtual ones: a virtual replica only sorts the
// results it considers relevant enough, and a price sort has to order every
// match. Each replica holds a copy of the records, which the catalog's size
// makes cheap.
export const replicaNames = (indexName: string): Record<Exclude<SearchSort, "RELEVANCE">, string> => ({
  PRICE_ASC: `${indexName}_price_asc`,
  PRICE_DESC: `${indexName}_price_desc`,
});

// In the order they are applied: the primary first, since setting its
// replicas is what creates them.
export const indexSettings = (indexName: string): { indexName: string; settings: IndexSettings }[] => {
  const replicas = replicaNames(indexName);
  return [
    { indexName, settings: { ...shared, ranking: RANKING, replicas: Object.values(replicas) } },
    { indexName: replicas.PRICE_ASC, settings: { ...shared, ranking: ["asc(settlementPrice)", ...RANKING] } },
    { indexName: replicas.PRICE_DESC, settings: { ...shared, ranking: ["desc(settlementPrice)", ...RANKING] } },
  ];
};
