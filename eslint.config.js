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
      // warn, no error: ya tienen tarea asignada (H8/H14 en ECOMAPI-13/15/19).
      "no-unused-vars": "warn",
      "no-useless-assignment": "warn",
      "no-constant-binary-expression": "warn",
    },
  },
];
