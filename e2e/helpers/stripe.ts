import Stripe from "stripe";
import { requireEnv } from "./env.js";

// The suite confirms payments with a Stripe secret key, so a live key would
// move real money. Anything that isn't a test key stops the run.
export const assertStripeTestKey = (key: string) => {
  if (!key.startsWith("sk_test_")) {
    throw new Error("E2E_STRIPE_SECRET_KEY must be a Stripe test key (sk_test_...); refusing to run against live mode");
  }
};

let client: Stripe | undefined;

export const getStripe = (): Stripe => {
  if (!client) {
    const key = requireEnv("E2E_STRIPE_SECRET_KEY");
    assertStripeTestKey(key);
    client = new Stripe(key);
  }
  return client;
};
