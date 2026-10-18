// The contract an exchange rate provider implements, the same way a catalog
// source implements CatalogSource: the rates job only knows this interface.

export interface ProviderRate {
  // ISO 4217 code of the currency the rate is for.
  currency: string;
  // How many units of the provider's base currency one unit of `currency` is.
  rate: number;
  // Date the provider publishes the rate for (YYYY-MM-DD).
  asOf: string;
}

export interface RateProvider {
  // Matches settings/pricing.rateProvider.
  readonly key: string;
  // The currency every rate is quoted in (MXN for Banxico).
  readonly baseCurrency: string;
  fetchRates(): Promise<ProviderRate[]>;
}
