import { createBanxicoProvider } from "./banxico.js";
import type { RateProvider } from "./ports.js";

// Every provider the code knows about, by the key settings/pricing uses.
const providers: Record<string, () => RateProvider> = {
  banxico: () => createBanxicoProvider(),
};

export const getRateProvider = (key: string): RateProvider => {
  const create = providers[key];
  if (!create) {
    throw new Error(`Unknown exchange rate provider "${key}"`);
  }
  return create();
};
