import { describe, it, expect } from "vitest";
import { computeOrderTotals } from "../src/utils/orderTotals.js";

describe("computeOrderTotals", () => {
  it("calculates 16% VAT on the subtotal", () => {
    const totals = computeOrderTotals([{ quantity: 1, subtotal: 10000 }]);

    expect(totals.subTotal).toBe(10000);
    expect(totals.taxes).toBe(1600);
    expect(totals.total).toBe(11600);
  });

  it("rounds VAT down, not to the nearest integer", () => {
    // 999 * 0.16 = 159.84 -> floor = 159. Math.round would give 160.
    const totals = computeOrderTotals([{ quantity: 1, subtotal: 999 }]);

    expect(totals.taxes).toBe(159);
  });

  it("an empty cart returns zeroed totals without throwing", () => {
    const totals = computeOrderTotals([]);

    expect(totals).toEqual({
      currency: "MXN",
      items: 0,
      units: 0,
      subTotal: 0,
      taxes: 0,
      discount: 0,
      total: 0,
    });
  });

  it("sums quantity and subtotal across several line items", () => {
    const totals = computeOrderTotals([
      { quantity: 2, subtotal: 5000 },
      { quantity: 1, subtotal: 3000 },
    ]);

    expect(totals.items).toBe(2);
    expect(totals.units).toBe(3);
    expect(totals.subTotal).toBe(8000);
  });
});
