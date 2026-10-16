import { describe, it, expect } from "vitest";
import { validateCartQuantity } from "../src/schema/validators/cartValidations.js";

describe("validateCartQuantity (H5)", () => {
  const product = { purchaseLimits: { min: 2, max: 10 }, stock: 5 };

  it("rejects a negative quantity", () => {
    expect(validateCartQuantity(-1, product)).toBe(false);
  });

  it("rejects a quantity outside purchaseLimits", () => {
    const highLimitProduct = { purchaseLimits: { min: 1, max: 10 }, stock: 100 };
    expect(validateCartQuantity(11, highLimitProduct)).toBe(false);
  });

  it("rejects a quantity above stock, even if within purchaseLimits", () => {
    // purchaseLimits allows up to 10, but there's only 5 in stock.
    expect(validateCartQuantity(6, product)).toBe(false);
  });

  it("accepts a valid quantity", () => {
    expect(validateCartQuantity(3, product)).toBe(true);
  });
});
