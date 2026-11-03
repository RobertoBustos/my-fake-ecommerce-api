import { listExchangeRates, writeExchangeRates, type StoredExchangeRate } from "#src/db/pricing";
import { metrics } from "#src/observability/metrics";
import { logger } from "#src/utils/logger";
import { roundRate } from "./convert.ts";
import { getRateProvider } from "./rateProviders/registry.ts";
import type { RateProvider } from "./rateProviders/ports.ts";
import { getPricingSettings } from "./settings.ts";

// A provider that keeps answering with an old date has stopped publishing;
// the rate is still used (its fetchedAt is fresh) but someone should look.
const STALE_AS_OF_DAYS = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

// Writes exchangeRates/{CUR}_{SETTLEMENT} for every currency the provider
// quotes. The provider quotes everything in its own base currency, so a
// settlement currency other than the base is reached by dividing two rates
// (USD→EUR = USD→MXN ÷ EUR→MXN).
export const refreshExchangeRates = async ({
  provider,
  now = new Date(),
}: { provider?: RateProvider; now?: Date } = {}) => {
  const settings = await getPricingSettings();
  const source = provider ?? getRateProvider(settings.rateProvider);
  const fetched = await source.fetchRates();

  const toBase = new Map<string, { rate: number; asOf: string | null }>([
    [source.baseCurrency, { rate: 1, asOf: null }],
  ]);
  for (const { currency, rate, asOf } of fetched) {
    toBase.set(currency, { rate, asOf });
  }

  const target = settings.settlementCurrency;
  const targetRate = toBase.get(target);
  if (!targetRate) {
    throw new Error(`${source.key} has no rate for the settlement currency ${target}`);
  }

  const written: ({ from: string; to: string } & StoredExchangeRate)[] = [];
  for (const [currency, { rate, asOf }] of toBase) {
    if (currency === target) continue;
    // The older of the two dates, since the cross rate is only as fresh as it.
    const dates = [asOf, targetRate.asOf].filter((date): date is string => date !== null).sort();
    written.push({
      from: currency,
      to: target,
      rate: roundRate(rate / targetRate.rate),
      asOf: dates[0] ?? now.toISOString().slice(0, 10),
      fetchedAt: now,
      source: source.key,
    });
  }
  await writeExchangeRates(written);

  for (const rate of written) {
    if (now.getTime() - new Date(rate.asOf).getTime() > STALE_AS_OF_DAYS * DAY_MS) {
      logger.warn("Exchange rate provider is publishing an old rate", {
        from: rate.from,
        to: rate.to,
        asOf: rate.asOf,
        source: rate.source,
      });
    }
  }
  return written;
};

// How old each stored rate is, from when the rates job last confirmed it
// (fetchedAt, the same clock as maxRateAgeHours). Recorded by sync-catalog on
// every run, because it prices the catalog for search with these rates; the
// rates job itself only runs once a day.
export const measureExchangeRateAges = async ({ now = new Date() }: { now?: Date } = {}) => {
  for (const { pair, rate } of await listExchangeRates()) {
    metrics.gauge("pricing.exchange_rate.age", (now.getTime() - rate.fetchedAt.getTime()) / 1000, { pair });
  }
};
