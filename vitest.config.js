import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e/ runs against the deployed API with its own config (npm run test:e2e),
    // and the hosted search contract against real engines with theirs
    // (npm run test:search:algolia).
    exclude: [...configDefaults.exclude, "e2e/**", "**/*.hosted.test.js"],
    setupFiles: ["./tests/setup.js"],
    globalSetup: ["./tests/globalSetup.js"],
    // Every file hits the same Firestore emulator instance; running them in
    // parallel causes contention and spurious timeouts in the tests that are
    // already heavy (transactions, batches).
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/services/**"],
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 70,
      },
    },
  },
});
