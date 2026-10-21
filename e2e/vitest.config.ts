import { defineConfig } from "vitest/config";

// The end-to-end suite runs against the deployed API (E2E_BASE_URL), with
// real Firebase Auth, Firestore and Stripe test mode: no emulator and none of
// the setup of tests/. It isn't part of `npm test` or the PR checks; run it
// with `npm run test:e2e`.
export default defineConfig({
  test: {
    root: "e2e",
    include: ["**/*.e2e.test.ts"],
    setupFiles: ["./setup.ts"],
    // Every file buys the same product, so they run one at a time.
    fileParallelism: false,
    // Network round trips to Cloud Run, Firebase and Stripe.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
