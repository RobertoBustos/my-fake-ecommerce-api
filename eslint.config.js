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
      // Bajadas a warning a propósito: el código que las dispara hoy ya
      // tiene tarea asignada para corregirse (H8/H14 en ECOMAPI-15,
      // ECOMAPI-13, ECOMAPI-19). ECOMAPI-10 solo monta la herramienta;
      // súbelas de nuevo a "error" cuando esas tareas se completen.
      "no-unused-vars": "warn",
      "no-useless-assignment": "warn",
      "no-constant-binary-expression": "warn",
    },
  },
];
