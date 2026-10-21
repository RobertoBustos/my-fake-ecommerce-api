import { describe, it, expect } from "vitest";
import { assertStripeTestKey } from "../e2e/helpers/stripe.js";
import { waitFor } from "../e2e/helpers/waitFor.js";

// The e2e suite itself only runs against the deployed API; these are the
// parts of its helpers that guard it, checked on every PR.
describe("e2e helpers", () => {
  it("accepts only a Stripe test key", () => {
    expect(() => assertStripeTestKey("sk_test_123")).not.toThrow();
    expect(() => assertStripeTestKey("sk_live_123")).toThrow("must be a Stripe test key");
    expect(() => assertStripeTestKey("rk_live_123")).toThrow("must be a Stripe test key");
  });

  it("waitFor returns the first value that satisfies the condition", async () => {
    let calls = 0;
    const value = await waitFor(async () => ++calls, (n) => n === 3, { timeoutMs: 1_000, intervalMs: 1 });
    expect(value).toBe(3);
    expect(calls).toBe(3);
  });

  it("waitFor gives up with the last value when time runs out", async () => {
    await expect(
      waitFor(async () => "PAYMENT_PENDING", (s) => s === "COMPLETE", {
        timeoutMs: 20,
        intervalMs: 5,
        description: "order COMPLETE",
      })
    ).rejects.toThrow('waiting for order COMPLETE; last value: "PAYMENT_PENDING"');
  });
});
