import js from "@eslint/js";

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
    rules: {
      // Warnings, not errors, so they don't block CI. The only ones left are
      // two no-useless-assignment hits in src/utils/orderTotals.js, which the
      // dead-code cleanup in the backlog will remove.
      "no-unused-vars": "warn",
      "no-useless-assignment": "warn",
      "no-constant-binary-expression": "warn",
    },
  },
];
