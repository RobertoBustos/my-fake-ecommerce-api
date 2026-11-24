// The only way the rest of the API reads feature flags. Services and
// resolvers import #src/flags; only src/flags/ may use the OpenFeature,
// GrowthBook or Remote Config SDKs (ESLint enforces it).
//
//   if (await isOn("newCheckout", ctx)) { ... }
//   const limit = await valueOf("cartItemLimit", ctx);
import { createFlags } from "./evaluate.ts";
import { flags } from "./registry.ts";

export const { isOn, valueOf } = createFlags(flags);
export { flagContext, UnknownFlagError } from "./evaluate.ts";
export { setupFlags, closeFlags } from "./setup.ts";
export type { FlagKey } from "./registry.ts";
