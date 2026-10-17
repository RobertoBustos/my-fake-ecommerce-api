import { describe, it, expect, vi, afterAll } from "vitest";
import { randomUUID } from "crypto";
import db from "../src/config/firestore.js";

const { searchMock, createMock, updateMock, paymentSearchMock } = vi.hoisted(() => ({
  searchMock: vi.fn().mockResolvedValue({ data: [] }),
  createMock: vi.fn().mockResolvedValue({ id: "cus_1" }),
  updateMock: vi.fn().mockResolvedValue({ id: "cus_1" }),
  paymentSearchMock: vi.fn().mockResolvedValue({ data: [] }),
}));

vi.mock("../src/config/stripe.js", () => ({
  default: {
    customers: {
      search: searchMock,
      create: createMock,
      update: updateMock,
    },
    paymentIntents: {
      search: paymentSearchMock,
    },
  },
}));

import { escapeStripeSearchValue, getCustomer, searchPayment } from "../src/db/payment.js";

const escapeTestUid = `escape-test-${randomUUID()}`;

afterAll(async () => {
  await db.collection("users").doc(escapeTestUid).delete();
});

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

  it("escapes double quotes and backslashes too", () => {
    expect(escapeStripeSearchValue('a"b\\c')).toBe('a\\"b\\\\c');
  });

  it("an email with a single quote never reaches a Stripe search query", async () => {
    await getCustomer(
      { email: "o'brien@example.com", name: "O'Brien", phone: "123" },
      escapeTestUid
    );

    // The customer is resolved by uid now, so the typed email is only data.
    expect(searchMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledWith("cus_1", {
      email: "o'brien@example.com",
      name: "O'Brien",
      phone: "123",
    });
  });

  it("escapes the order id in the PaymentIntent search", async () => {
    await searchPayment("order", 'x" OR status:"succeeded');

    expect(paymentSearchMock).toHaveBeenCalledWith({
      query: 'metadata["order_id"]: "x\\" OR status:\\"succeeded"',
    });
  });
});
