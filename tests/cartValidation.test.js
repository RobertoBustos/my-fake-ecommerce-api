import { describe, it, expect } from "vitest";
import { validateCartQuantity } from "../src/schema/validators/cartValidations.js";

describe("validateCartQuantity (H5)", () => {
  const product = { purchaseLimits: { min: 2, max: 10 }, stock: 5 };

  it("rechaza cantidad negativa", () => {
    expect(validateCartQuantity(-1, product)).toBe(false);
  });

  it("rechaza cantidad fuera de purchaseLimits", () => {
    const highLimitProduct = { purchaseLimits: { min: 1, max: 10 }, stock: 100 };
    expect(validateCartQuantity(11, highLimitProduct)).toBe(false);
  });

  it("rechaza cantidad mayor al stock, aunque esté dentro de purchaseLimits", () => {
    // purchaseLimits permite hasta 10, pero solo hay 5 en stock.
    expect(validateCartQuantity(6, product)).toBe(false);
  });

  it("acepta una cantidad válida", () => {
    expect(validateCartQuantity(3, product)).toBe(true);
  });
});
