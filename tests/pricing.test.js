import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";
import { createLoaders } from "../src/dataloaders/index.js";
import db from "../src/config/firestore.js";
import { toGlobalProductId } from "../src/catalog/index.js";
import {
  convertPrice,
  DEFAULT_PRICING_SETTINGS,
  ExchangeRateUnavailableError,
  getPricingSettings,
  quotePrice,
  refreshExchangeRates,
} from "../src/pricing/index.js";
import { createBanxicoProvider } from "../src/pricing/rateProviders/banxico.js";
import { logger } from "../src/utils/logger.js";

const { payment } = vi.hoisted(() => ({
  payment: {
    cancelPayment: vi.fn().mockResolvedValue(true),
    createPayment: vi.fn().mockResolvedValue({
      paymentId: "pi_pricing",
      clientSecret: "secret",
      ephimeralKey: "ek",
    }),
    getCustomer: vi.fn().mockResolvedValue({ id: "cus_pricing" }),
    searchPayment: vi.fn().mockResolvedValue(null),
    searchPaymentMethod: vi.fn(),
  },
}));
vi.mock("../src/db/payment.js", () => payment);

// Settings are read from Firestore on every call, so a change applies at once.
process.env.PRICING_SETTINGS_TTL_MS = "0";

const settingsRef = db.collection("settings").doc("pricing");
const rateRef = (pair) => db.collection("exchangeRates").doc(pair);
const setRate = (pair, rate, fetchedAt = new Date()) =>
  rateRef(pair).set({ rate, asOf: "2026-10-16", fetchedAt, source: "test" });
const resetPricing = async () => {
  await settingsRef.delete();
  await Promise.all(["USD_MXN", "MXN_USD", "EUR_MXN"].map((pair) => rateRef(pair).delete()));
};

const HOUR = 60 * 60 * 1000;

describe("convertPrice (ECOMAPI-80)", () => {
  it("converts integer cents with the rate", () => {
    expect(convertPrice(1000, 17.5)).toBe(17500);
    expect(convertPrice(0, 17.5)).toBe(0);
  });

  it("doesn't pick up binary floating point errors", () => {
    // 10000 × 17.0123 in plain floats is 170122.99999999997.
    expect(convertPrice(10000, 17.0123)).toBe(170123);
  });

  it("rounds exactly half a cent to the even cent", () => {
    expect(convertPrice(5, 0.5)).toBe(2); // 2.5 → 2
    expect(convertPrice(3, 0.5)).toBe(2); // 1.5 → 2
    expect(convertPrice(7, 0.5)).toBe(4); // 3.5 → 4
    expect(convertPrice(1, 0.4)).toBe(0);
    expect(convertPrice(1, 0.6)).toBe(1);
  });

  it("rejects amounts that aren't cents and rates that aren't positive", () => {
    expect(() => convertPrice(10.5, 2)).toThrow(RangeError);
    expect(() => convertPrice(-1, 2)).toThrow(RangeError);
    expect(() => convertPrice(100, 0)).toThrow(RangeError);
  });
});

describe("pricing settings (ECOMAPI-80)", () => {
  afterEach(resetPricing);

  it("uses MXN while settings/pricing doesn't exist", async () => {
    await settingsRef.delete();
    expect(await getPricingSettings()).toEqual(DEFAULT_PRICING_SETTINGS);
  });

  it("picks up a new settlement currency without restarting", async () => {
    await settingsRef.set({ settlementCurrency: "USD", rateProvider: "banxico", maxRateAgeHours: 24 });
    expect((await getPricingSettings()).settlementCurrency).toBe("USD");

    await settingsRef.update({ settlementCurrency: "MXN" });
    expect((await getPricingSettings()).settlementCurrency).toBe("MXN");
  });

  it("keeps the last valid settings when the document is invalid", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    await settingsRef.set({ settlementCurrency: "USD", rateProvider: "banxico", maxRateAgeHours: 24 });
    await getPricingSettings();

    await settingsRef.set({ settlementCurrency: "dollars", rateProvider: "banxico", maxRateAgeHours: 24 });
    expect((await getPricingSettings()).settlementCurrency).toBe("USD");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("settings/pricing is invalid"),
      expect.any(Object)
    );
    errorSpy.mockRestore();
  });
});

describe("quotePrice (ECOMAPI-80)", () => {
  afterEach(resetPricing);

  it("leaves a price in the settlement currency as it is", async () => {
    expect(await quotePrice({ unitPrice: 1000, currency: "MXN" })).toEqual({
      unitPrice: 1000,
      currency: "MXN",
      originalUnitPrice: null,
      originalCurrency: null,
      exchangeRate: null,
      rateAsOf: null,
    });
  });

  it("converts another currency and keeps the original price, the rate and its date", async () => {
    await setRate("USD_MXN", 18.25);
    expect(await quotePrice({ unitPrice: 1000, currency: "USD" })).toEqual({
      unitPrice: 18250,
      currency: "MXN",
      originalUnitPrice: 1000,
      originalCurrency: "USD",
      exchangeRate: 18.25,
      rateAsOf: "2026-10-16",
    });
  });

  it("refuses a missing rate and logs an ERROR", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    await expect(quotePrice({ unitPrice: 1000, currency: "USD" })).rejects.toBeInstanceOf(
      ExchangeRateUnavailableError
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Exchange rate unavailable"),
      expect.objectContaining({ from: "USD", to: "MXN" })
    );
    errorSpy.mockRestore();
  });

  it("refuses a rate older than maxRateAgeHours", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    await setRate("USD_MXN", 18.25, new Date(Date.now() - 25 * HOUR));
    await expect(quotePrice({ unitPrice: 1000, currency: "USD" })).rejects.toBeInstanceOf(
      ExchangeRateUnavailableError
    );

    await settingsRef.set({ settlementCurrency: "MXN", rateProvider: "banxico", maxRateAgeHours: 48 });
    expect((await quotePrice({ unitPrice: 1000, currency: "USD" })).unitPrice).toBe(18250);
    errorSpy.mockRestore();
  });
});

describe("exchange rates job (ECOMAPI-80)", () => {
  afterEach(resetPricing);

  const provider = {
    key: "test",
    baseCurrency: "MXN",
    fetchRates: async () => [
      { currency: "USD", rate: 18, asOf: "2026-10-16" },
      { currency: "EUR", rate: 20, asOf: "2026-10-15" },
    ],
  };

  it("writes every currency against the settlement currency", async () => {
    const now = new Date("2026-10-17T12:00:00Z");
    await refreshExchangeRates({ provider, now });

    const usd = (await rateRef("USD_MXN").get()).data();
    expect(usd).toMatchObject({ rate: 18, asOf: "2026-10-16", source: "test" });
    expect(usd.fetchedAt.toDate()).toEqual(now);
    expect((await rateRef("EUR_MXN").get()).data()).toMatchObject({ rate: 20 });
  });

  it("derives cross rates when the settlement currency isn't the provider's base", async () => {
    await settingsRef.set({ settlementCurrency: "USD", rateProvider: "banxico", maxRateAgeHours: 24 });
    const written = await refreshExchangeRates({ provider, now: new Date("2026-10-17T12:00:00Z") });

    expect(written.map(({ from, to }) => `${from}_${to}`).sort()).toEqual(["EUR_USD", "MXN_USD"]);
    expect(written.find((r) => r.from === "MXN").rate).toBe(0.05555556);
    // Only as fresh as the older of the two rates.
    expect(written.find((r) => r.from === "EUR")).toMatchObject({ rate: 1.11111111, asOf: "2026-10-15" });
    await Promise.all(["EUR_USD", "MXN_USD"].map((pair) => rateRef(pair).delete()));
  });

  it("fails when the provider has no rate for the settlement currency", async () => {
    await settingsRef.set({ settlementCurrency: "GBP", rateProvider: "banxico", maxRateAgeHours: 24 });
    await expect(refreshExchangeRates({ provider })).rejects.toThrow(/settlement currency GBP/);
  });
});

describe("Banxico rate provider (ECOMAPI-80)", () => {
  const respond = (body, ok = true) => vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 503, json: async () => body });

  it("reads the latest FIX rate with the token", async () => {
    const fetchImpl = respond({
      bmx: { series: [{ idSerie: "SF43718", datos: [{ fecha: "16/10/2026", dato: "18.2345" }] }] },
    });
    const rates = await createBanxicoProvider({ token: "t0ken", fetchImpl }).fetchRates();

    expect(rates).toEqual([{ currency: "USD", rate: 18.2345, asOf: "2026-10-16" }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/SF43718/datos/oportuno");
    expect(init.headers["Bmx-Token"]).toBe("t0ken");
  });

  it("skips a series without a value", async () => {
    const fetchImpl = respond({
      bmx: { series: [{ idSerie: "SF43718", datos: [{ fecha: "16/10/2026", dato: "N/E" }] }] },
    });
    expect(await createBanxicoProvider({ token: "t", fetchImpl }).fetchRates()).toEqual([]);
  });

  it("fails without a token or when Banxico answers an error", async () => {
    await expect(createBanxicoProvider({ token: "", fetchImpl: respond({}) }).fetchRates()).rejects.toThrow(
      /BANXICO_TOKEN/
    );
    await expect(
      createBanxicoProvider({ token: "t", fetchImpl: respond({}, false) }).fetchRates()
    ).rejects.toThrow(/503/);
  });
});

describe("a product priced in another currency (ECOMAPI-80)", () => {
  const USER = "user-pricing";
  const server = new ApolloServer({ typeDefs, resolvers });
  const run = async (query, variables) => {
    const response = await server.executeOperation(
      { query, variables },
      { contextValue: { user: { uid: USER }, loaders: createLoaders() } }
    );
    return response.body.singleResult;
  };
  const errorOf = (result) => result.errors?.[0]?.extensions;

  const localId = `test-usd-${randomUUID()}`;
  const productId = toGlobalProductId("fs", localId);
  const cartIds = [];
  const orderIds = [];
  const newCart = () => {
    const cartId = `cart-pricing-${randomUUID()}`;
    cartIds.push(cartId);
    return cartId;
  };

  const ADD = `mutation ($input: AddToCart!) {
    addToCart(input: $input) { success data { id unitPrice subtotal currency } }
  }`;
  const PAY = `mutation ($input: CreateOrderPayment!) { createOrderPayment(input: $input) { success } }`;

  const orderFor = async (cartId) => {
    const created = await run(`mutation ($input: CreateOrder!) { createOrder(input: $input) { data { id } } }`, {
      input: { cartId },
    });
    const orderId = created.data.createOrder.data.id;
    orderIds.push(orderId);
    await run(`mutation ($input: UpdateOrder!) { updateOrder(input: $input) { success } }`, {
      input: {
        id: orderId,
        customer: { email: "p@example.com", name: "Pricing", phone: "5555555555" },
        address: {
          address: "Calle 1",
          zipCode: "01000",
          coords: { latitude: 1, longitude: 1, latitudeDelta: 1, longitudeDelta: 1 },
        },
      },
    });
    return orderId;
  };

  beforeAll(async () => {
    await db.collection("products").doc(localId).set({
      title: "USD fixture",
      description: "",
      category: "test-pricing",
      image: "",
      currency: "USD",
      unitPrice: 1000,
      purchaseLimits: { min: 1, max: 10 },
      stock: 50,
    });
  });

  afterEach(resetPricing);

  afterAll(async () => {
    await db.collection("products").doc(localId).delete();
    await Promise.all(orderIds.map((id) => db.collection("orders").doc(id).delete()));
    for (const cartId of cartIds) {
      const items = await db.collection("cartItems").where("cartId", "==", cartId).get();
      await Promise.all(items.docs.map((doc) => doc.ref.delete()));
    }
  });

  it("is listed and added to the cart in the settlement currency", async () => {
    await setRate("USD_MXN", 18);
    const listed = await run(`query ($id: ID) { products(id: $id) { edges { node { unitPrice currency } } } }`, {
      id: productId,
    });
    expect(listed.data.products.edges[0].node).toEqual({ unitPrice: 18000, currency: "MXN" });

    const cartId = newCart();
    const added = await run(ADD, { input: { cartId, productId, quantity: 2 } });
    expect(added.errors).toBeUndefined();
    expect(added.data.addToCart.data).toMatchObject({ unitPrice: 18000, subtotal: 36000, currency: "MXN" });

    const stored = (await db.collection("cartItems").doc(added.data.addToCart.data.id).get()).data();
    expect(stored).toMatchObject({
      unitPrice: 18000,
      currency: "MXN",
      originalUnitPrice: 1000,
      originalCurrency: "USD",
      exchangeRate: 18,
      rateAsOf: "2026-10-16",
    });
  });

  it("can't be added without a fresh rate, and is shown in its own currency meanwhile", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    await setRate("USD_MXN", 18, new Date(Date.now() - 30 * HOUR));
    const stockBefore = (await db.collection("products").doc(localId).get()).get("stock");

    const added = await run(ADD, { input: { cartId: newCart(), productId, quantity: 1 } });
    expect(errorOf(added)).toMatchObject({ code: "CONFLICT", retryable: true });
    expect((await db.collection("products").doc(localId).get()).get("stock")).toBe(stockBefore);

    const listed = await run(`query ($id: ID) { products(id: $id) { edges { node { unitPrice currency } } } }`, {
      id: productId,
    });
    expect(listed.data.products.edges[0].node).toEqual({ unitPrice: 1000, currency: "USD" });
    errorSpy.mockRestore();
  });

  it("is charged at today's rate: a new rate reprices the order before paying", async () => {
    await setRate("USD_MXN", 18);
    const cartId = newCart();
    await run(ADD, { input: { cartId, productId, quantity: 1 } });
    const orderId = await orderFor(cartId);

    await setRate("USD_MXN", 19);
    payment.createPayment.mockClear();
    const refused = await run(PAY, { input: { orderId } });
    expect(errorOf(refused)).toMatchObject({
      code: "BAD_USER_INPUT",
      priceChanges: [{ previousUnitPrice: 18000, unitPrice: 19000, currency: "MXN" }],
    });
    expect(payment.createPayment).not.toHaveBeenCalled();

    const paid = await run(PAY, { input: { orderId } });
    expect(paid.errors).toBeUndefined();
    // 19000 plus 16% tax.
    expect(payment.createPayment).toHaveBeenCalledWith(orderId, 22040, "cus_pricing", "MXN");
  });

  it("is charged in the new settlement currency after it changes", async () => {
    await setRate("USD_MXN", 18);
    const cartId = newCart();
    await run(ADD, { input: { cartId, productId, quantity: 1 } });
    const orderId = await orderFor(cartId);

    await settingsRef.set({ settlementCurrency: "USD", rateProvider: "banxico", maxRateAgeHours: 24 });
    payment.createPayment.mockClear();
    const refused = await run(PAY, { input: { orderId } });
    expect(errorOf(refused)).toMatchObject({
      priceChanges: [{ previousUnitPrice: 18000, previousCurrency: "MXN", unitPrice: 1000, currency: "USD" }],
    });

    const paid = await run(PAY, { input: { orderId } });
    expect(paid.errors).toBeUndefined();
    expect(payment.createPayment).toHaveBeenCalledWith(orderId, 1160, "cus_pricing", "USD");
    const [item] = (await db.collection("cartItems").where("orderId", "==", orderId).get()).docs;
    expect(item.data()).toMatchObject({ unitPrice: 1000, currency: "USD", originalCurrency: null });
  });
});
