import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Layering: GraphQL resolvers that write must go through services/ (where
// validation and business rules live), never straight to the data layer.
// Reads are allowed to use db/ directly, so queries.ts and fields.ts are
// exempt; everything else under src/schema/ is not.
const dataLayerImports = {
  patterns: [
    {
      regex: "(^|/)db(/|$)",
      message: "Writes go through src/services/; only queries.ts and fields.ts may read db/ directly.",
    },
    {
      regex: "(^|/)config/(firestore|stripe)(\\.js)?$",
      message: "Resolvers must not talk to Firestore or Stripe directly; use src/services/.",
    },
  ],
};

// Catalog sources: only an adapter under src/catalog/sources/ may talk to a
// product database. The rest of the catalog and the services reach products
// and stock through the CatalogSource contract.
const databaseClientImports = {
  patterns: [
    {
      regex: "(^|/)config/firestore(\\.js)?$|^firebase-admin/firestore$|^(mysql2|mongodb|pg)(/|$)|^@supabase/",
      message: "Only a catalog adapter in src/catalog/sources/ may use a database client; go through CatalogSource.",
    },
  ],
};

// Search engines: only an adapter under src/search/adapters/ may use an
// engine's SDK. The rest of the API searches through the SearchIndex port, so
// changing engines is writing another adapter.
const searchEngineImports = {
  patterns: [
    {
      regex: "^(algoliasearch|@algolia/|typesense|meilisearch|@elastic/|@opensearch-project/)",
      message: "Only a search adapter in src/search/adapters/ may use a search engine SDK; go through SearchIndex.",
    },
  ],
};

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "src/generated/"] },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        URL: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  // A file matched by several of these blocks gets only the last block's
  // no-restricted-imports, so the later blocks repeat the search engine
  // patterns instead of losing them.
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    ignores: ["src/search/adapters/**"],
    rules: {
      "no-restricted-imports": ["error", searchEngineImports],
    },
  },
  {
    files: ["src/schema/**/*.ts"],
    ignores: ["src/schema/resolvers/queries.ts", "src/schema/resolvers/fields.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [...dataLayerImports.patterns, ...searchEngineImports.patterns] },
      ],
    },
  },
  {
    files: ["src/catalog/**/*.ts", "src/services/**/*.ts"],
    ignores: ["src/catalog/sources/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [...databaseClientImports.patterns, ...searchEngineImports.patterns] },
      ],
    },
  }
);
