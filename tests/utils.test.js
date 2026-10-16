import { describe, it, expect } from "vitest";
import { readFile } from "../src/utils/fileUtils.js";
import { fakePromise } from "../src/utils/fakePromise.js";

describe("fileUtils (H8)", () => {
  it("readFile on a nonexistent file rejects exactly once, without crashing afterward", async () => {
    // Before the fix, a `return` was missing after reject(err): execution
    // kept going and JSON.parse(undefined) crashed outside the promise.
    await expect(readFile("../data/no-existe.json")).rejects.toBeTruthy();
  });
});

describe("fakePromise (H14)", () => {
  it("respects the milliseconds it receives, not a fixed 1000", async () => {
    const start = Date.now();
    await fakePromise(30);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(500);
  });
});
