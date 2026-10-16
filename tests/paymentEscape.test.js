import { describe, it, expect, vi } from "vitest";

const { searchMock, createMock } = vi.hoisted(() => ({
  searchMock: vi.fn().mockResolvedValue({ data: [] }),
  createMock: vi.fn().mockResolvedValue({ id: "cus_1", phone: "123" }),
}));

vi.mock("../src/config/stripe.js", () => ({
  default: {
    customers: {
      search: searchMock,
      create: createMock,
      update: vi.fn(),
    },
  },
}));

import { escapeStripeSearchValue, getCustomer } from "../src/db/payment.js";

describe("Stripe search query escaping (H4)", () => {
  it("escapes the single quote before building the query", () => {
    expect(escapeStripeSearchValue("o'brien@example.com")).toBe(
      "o\\'brien@example.com"
    );
  });

  it("doesn't touch an email without quotes", () => {
    expect(escapeStripeSearchValue("normal@example.com")).toBe(
      "normal@example.com"
    );
  });

  it("an email with a single quote produces a safe query to Stripe", async () => {
    await getCustomer({
      email: "o'brien@example.com",
      name: "O'Brien",
      phone: "123",
    });

    expect(searchMock).toHaveBeenCalledWith({
      query: "email:'o\\'brien@example.com'",
    });
  });
});
