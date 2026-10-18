import { readExchangeRate } from "../db/pricing.js";
import { logger } from "../utils/logger.js";
import { convertPrice } from "./convert.js";
import { getPricingSettings } from "./settings.js";

// Cart items written before prices carried a currency were all in MXN.
export const LEGACY_CURRENCY = "MXN";

export class ExchangeRateUnavailableError extends Error {
  from: string;
  to: string;
  constructor(from: string, to: string, reason: string) {
    super(`No usable exchange rate from ${from} to ${to}: ${reason}`);
    this.name = "ExchangeRateUnavailableError";
    this.from = from;
    this.to = to;
  }
}

// A price in the settlement currency, with what it was converted from. The
// original fields are null when the source already quotes the settlement
// currency.
export interface PriceQuote {
  unitPrice: number;
  currency: string;
  originalUnitPrice: number | null;
  originalCurrency: string | null;
  exchangeRate: number | null;
  rateAsOf: string | null;
}

const HOUR_MS = 60 * 60 * 1000;

// Throws ExchangeRateUnavailableError (and logs an ERROR, since someone has
// to fix the rates job) when the rate is missing or older than
// maxRateAgeHours. Age is counted from the last time the job confirmed the
// rate, not from the rate's own date, which doesn't move on weekends.
export const getUsableRate = async (from: string, to: string, maxRateAgeHours: number) => {
  const stored = await readExchangeRate(from, to);
  let reason: string | null = null;
  if (!stored) {
    reason = "missing";
  } else if (Date.now() - stored.fetchedAt.getTime() > maxRateAgeHours * HOUR_MS) {
    reason = `last refreshed ${stored.fetchedAt.toISOString()}, older than ${maxRateAgeHours}h`;
  }
  if (reason || !stored) {
    const error = new ExchangeRateUnavailableError(from, to, reason ?? "missing");
    logger.error("Exchange rate unavailable; products in this currency can't be sold", {
      from,
      to,
      reason,
    });
    throw error;
  }
  return stored;
};

export const quotePrice = async ({
  unitPrice,
  currency,
}: {
  unitPrice: number;
  currency: string | null | undefined;
}): Promise<PriceQuote> => {
  const { settlementCurrency, maxRateAgeHours } = await getPricingSettings();
  const from = currency ?? LEGACY_CURRENCY;
  if (from === settlementCurrency) {
    return {
      unitPrice,
      currency: settlementCurrency,
      originalUnitPrice: null,
      originalCurrency: null,
      exchangeRate: null,
      rateAsOf: null,
    };
  }
  const rate = await getUsableRate(from, settlementCurrency, maxRateAgeHours);
  return {
    unitPrice: convertPrice(unitPrice, rate.rate),
    currency: settlementCurrency,
    originalUnitPrice: unitPrice,
    originalCurrency: from,
    exchangeRate: rate.rate,
    rateAsOf: rate.asOf,
  };
};
