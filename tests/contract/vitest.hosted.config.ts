import { defineConfig } from "vitest/config";

// The search contract against hosted engines (*.hosted.test.js), with their
// real keys: no emulator and none of the setup of tests/. It isn't part of
// `npm test` or the PR checks; run it with `npm run test:search:algolia`.
export default defineConfig({
  test: {
    root: "tests/contract",
    include: ["**/*.hosted.test.js"],
    // Configuring a new index and its replicas, and deleting them, takes a
    // while; each check sets its own timeout (describeSearchIndexContract).
    hookTimeout: 120_000,
  },
});
