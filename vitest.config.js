import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.js"],
    globalSetup: ["./tests/globalSetup.js"],
    // Todos los archivos pegan contra la misma instancia del emulador de
    // Firestore; correrlos en paralelo genera contención y timeouts falsos
    // en las pruebas que ya de por sí son pesadas (transacciones, batches).
    fileParallelism: false,
  },
});
