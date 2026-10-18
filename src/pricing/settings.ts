import { z } from "zod";
import env from "../config/env.js";
import { readPricingSettings } from "../db/pricing.js";
import { logger } from "../utils/logger.js";

// The settlement currency lives in Firestore (settings/pricing), not in the
// code: changing it is an edit to that document, picked up within a few
// seconds by every running instance, without a deploy.

const pricingSettingsSchema = z.object({
  // ISO 4217, upper case: "MXN", "USD"...
  settlementCurrency: z.string().regex(/^[A-Z]{3}$/),
  rateProvider: z.string().min(1),
  maxRateAgeHours: z.number().positive(),
});

export type PricingSettings = z.infer<typeof pricingSettingsSchema>;

// What applies while settings/pricing doesn't exist yet: every price the
// catalog had before this setting existed was in MXN.
export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  settlementCurrency: "MXN",
  rateProvider: "banxico",
  maxRateAgeHours: 24,
};

const DEFAULT_TTL_MS = 30_000;

let cached: { settings: PricingSettings; expiresAt: number } | null = null;
let lastValid: PricingSettings = DEFAULT_PRICING_SETTINGS;

// PRICING_SETTINGS_TTL_MS is read on every call, so tests can set it to 0.
const ttlMs = () => {
  const value = Number(env.PRICING_SETTINGS_TTL_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TTL_MS;
};

// An invalid document is logged and ignored: the last valid settings (or the
// defaults) keep applying, so a typo in the console can't stop sales.
export const getPricingSettings = async (): Promise<PricingSettings> => {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.settings;
  }
  const raw = await readPricingSettings();
  let settings: PricingSettings;
  if (raw === undefined) {
    settings = DEFAULT_PRICING_SETTINGS;
  } else {
    const parsed = pricingSettingsSchema.safeParse(raw);
    if (parsed.success) {
      settings = parsed.data;
      lastValid = settings;
    } else {
      logger.error("settings/pricing is invalid; keeping the last valid pricing settings", {
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        settlementCurrency: lastValid.settlementCurrency,
      });
      settings = lastValid;
    }
  }
  cached = { settings, expiresAt: now + ttlMs() };
  return settings;
};
