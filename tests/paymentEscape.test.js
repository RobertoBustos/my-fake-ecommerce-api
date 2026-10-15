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
  it("escapa la comilla simple antes de construir el query", () => {
    expect(escapeStripeSearchValue("o'brien@example.com")).toBe(
      "o\\'brien@example.com"
    );
  });

  it("no toca un email sin comillas", () => {
    expect(escapeStripeSearchValue("normal@example.com")).toBe(
      "normal@example.com"
    );
  });

  it("un email con comilla simple genera una consulta segura hacia Stripe", async () => {
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
