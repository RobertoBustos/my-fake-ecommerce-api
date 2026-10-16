import js from "@eslint/js";

// Layering: GraphQL resolvers that write must go through services/ (where
// validation and business rules live), never straight to the data layer.
// Reads are allowed to use db/ directly, so queries.js and fields.js are
// exempt; everything else under src/schema/ is not.
const dataLayerImports = {
  patterns: [
    {
      regex: "(^|/)db(/|$)",
      message: "Writes go through src/services/; only queries.js and fields.js may read db/ directly.",
    },
    {
      regex: "(^|/)config/(firestore|stripe)(\\.js)?$",
      message: "Resolvers must not talk to Firestore or Stripe directly; use src/services/.",
    },
  ],
};

export default [
  js.configs.recommended,
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
    files: ["src/schema/**/*.js"],
    ignores: ["src/schema/resolvers/queries.js", "src/schema/resolvers/fields.js"],
    rules: {
      "no-restricted-imports": ["error", dataLayerImports],
    },
  },
];
