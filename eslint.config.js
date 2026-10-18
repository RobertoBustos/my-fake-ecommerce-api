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
  {
    files: ["src/schema/**/*.ts"],
    ignores: ["src/schema/resolvers/queries.ts", "src/schema/resolvers/fields.ts"],
    rules: {
      "no-restricted-imports": ["error", dataLayerImports],
    },
  },
  {
    files: ["src/catalog/**/*.ts", "src/services/**/*.ts"],
    ignores: ["src/catalog/sources/**"],
    rules: {
      "no-restricted-imports": ["error", databaseClientImports],
    },
  }
);
