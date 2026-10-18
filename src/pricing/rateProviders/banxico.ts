import env from "../../config/env.js";
import type { ProviderRate, RateProvider } from "./ports.js";

// Banco de México's SIE API. Each currency is a series; "oportuno" returns
// its latest published value. SF43718 is the FIX rate (pesos per US dollar)
// that Banxico publishes every banking day. A currency is added by adding
// its series here.
const SERIES: Record<string, string> = {
  USD: "SF43718",
};

const BASE_URL = "https://www.banxico.org.mx/SieAPIRest/service/v1/series";

interface SieResponse {
  bmx?: {
    series?: { idSerie: string; datos?: { fecha: string; dato: string }[] }[];
  };
}

// Banxico writes dates as DD/MM/YYYY and amounts with thousands separators.
const toIsoDate = (fecha: string) => {
  const [day, month, year] = fecha.split("/");
  return `${year}-${month}-${day}`;
};

export const createBanxicoProvider = ({
  token = env.BANXICO_TOKEN,
  fetchImpl = fetch,
}: { token?: string; fetchImpl?: typeof fetch } = {}): RateProvider => ({
  key: "banxico",
  baseCurrency: "MXN",

  async fetchRates(): Promise<ProviderRate[]> {
    if (!token) {
      throw new Error("BANXICO_TOKEN is not set");
    }
    const byId = new Map(Object.entries(SERIES).map(([currency, id]) => [id, currency]));
    const response = await fetchImpl(`${BASE_URL}/${[...byId.keys()].join(",")}/datos/oportuno`, {
      headers: { "Bmx-Token": token, Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Banxico answered ${response.status}`);
    }
    const body = (await response.json()) as SieResponse;
    const rates: ProviderRate[] = [];
    for (const serie of body.bmx?.series ?? []) {
      const currency = byId.get(serie.idSerie);
      const latest = serie.datos?.at(-1);
      // "N/E" means there is no value for that date.
      const rate = latest ? Number(latest.dato.replace(/,/g, "")) : NaN;
      if (currency && latest && Number.isFinite(rate) && rate > 0) {
        rates.push({ currency, rate, asOf: toIsoDate(latest.fecha) });
      }
    }
    return rates;
  },
});
