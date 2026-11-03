import db from "#src/config/firestore";

// settings/pricing holds the settlement currency and how exchange rates are
// kept; exchangeRates/{FROM}_{TO} holds one rate each. Both are written by
// people (settings) or the daily rates job (rates), never by a client.

const SETTINGS_COLLECTION = "settings";
const PRICING_DOC = "pricing";
const RATES_COLLECTION = "exchangeRates";

export interface StoredExchangeRate {
  rate: number;
  // Date the provider says the rate is for ("2026-10-17").
  asOf: string;
  // When the rates job last confirmed it; staleness is measured from here.
  fetchedAt: Date;
  source: string;
}

export const rateDocId = (from: string, to: string) => `${from}_${to}`;

export const readPricingSettings = async (): Promise<unknown> =>
  (await db.collection(SETTINGS_COLLECTION).doc(PRICING_DOC).get()).data();

export const writePricingSettings = async (settings: Record<string, unknown>): Promise<void> => {
  await db.collection(SETTINGS_COLLECTION).doc(PRICING_DOC).set(settings);
};

const toStoredRate = (data: Record<string, unknown>): StoredExchangeRate => {
  const { fetchedAt, ...rest } = data as Omit<StoredExchangeRate, "fetchedAt"> & {
    fetchedAt: { toDate(): Date } | Date;
  };
  return { ...rest, fetchedAt: fetchedAt instanceof Date ? fetchedAt : fetchedAt.toDate() };
};

// Every stored rate, by its pair ("USD_MXN"). There is one document per pair
// the catalog has needed, so the list stays short.
export const listExchangeRates = async (): Promise<{ pair: string; rate: StoredExchangeRate }[]> =>
  (await db.collection(RATES_COLLECTION).get()).docs.map((doc) => ({ pair: doc.id, rate: toStoredRate(doc.data()) }));

export const readExchangeRate = async (
  from: string,
  to: string
): Promise<StoredExchangeRate | null> => {
  const doc = await db.collection(RATES_COLLECTION).doc(rateDocId(from, to)).get();
  if (!doc.exists) return null;
  return toStoredRate(doc.data() as Record<string, unknown>);
};

export const writeExchangeRates = async (
  rates: ({ from: string; to: string } & StoredExchangeRate)[]
): Promise<void> => {
  const batch = db.batch();
  for (const { from, to, ...rate } of rates) {
    batch.set(db.collection(RATES_COLLECTION).doc(rateDocId(from, to)), rate);
  }
  await batch.commit();
};
