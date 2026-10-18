import DataLoader from "dataloader";
import { convertPrice, getPricingSettings, LEGACY_CURRENCY } from "../pricing/index.js";
import { getUsableRate } from "../pricing/quote.js";

export interface DisplayPrice {
  unitPrice: number;
  currency: string;
}

const keyOf = ({ unitPrice, currency }: { unitPrice: number; currency: string | null | undefined }) =>
  `${unitPrice}:${currency ?? LEGACY_CURRENCY}`;

// New instance per request. The price a product is shown at, in the
// settlement currency: each currency's rate is read once per request however
// many products use it. Without a usable rate the product keeps its own
// price and currency (the missing rate is logged once per request), and
// adding it to a cart answers CONFLICT until the rate is back.
export const createDisplayPriceLoader = () =>
  new DataLoader<{ unitPrice: number; currency: string | null | undefined }, DisplayPrice, string>(
    async (prices) => {
      const { settlementCurrency, maxRateAgeHours } = await getPricingSettings();
      const currencies = [
        ...new Set(prices.map(({ currency }) => currency ?? LEGACY_CURRENCY)),
      ].filter((currency) => currency !== settlementCurrency);
      const rates = new Map(
        await Promise.all(
          currencies.map(async (currency) => {
            const rate = await getUsableRate(currency, settlementCurrency, maxRateAgeHours).catch(
              () => null
            );
            return [currency, rate?.rate ?? null] as const;
          })
        )
      );
      return prices.map(({ unitPrice, currency }) => {
        const from = currency ?? LEGACY_CURRENCY;
        if (from === settlementCurrency) return { unitPrice, currency: from };
        const rate = rates.get(from);
        return rate ? { unitPrice: convertPrice(unitPrice, rate), currency: settlementCurrency } : { unitPrice, currency: from };
      });
    },
    { cacheKeyFn: keyOf }
  );
