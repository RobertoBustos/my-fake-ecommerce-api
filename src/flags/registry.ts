// Every feature flag the API reads, declared once. A flag that isn't here
// can't be read: isOn/valueOf only accept these keys.
//
// owner decides which tool serves it:
// - "release": GrowthBook. Short-lived flags that hide unfinished work or
//   roll it out gradually; each one has a removeBy date, and a test fails
//   once it passes so they don't pile up.
// - "ops": Firebase Remote Config. Operational switches that stay (kill
//   switches, limits), changed from the Firebase console.
//
// Until a provider is wired for an owner, a flag answers with its
// defaultValue, unless FLAG_<KEY> overrides it (see providers/envOverride.ts).

export type FlagOwner = "release" | "ops";
export type FlagValue = boolean | string | number;

interface BaseFlag<T extends FlagValue> {
  defaultValue: T;
  description: string;
  // Who decides when it changes and when it goes away.
  responsible: string;
}

export interface ReleaseFlag<T extends FlagValue = FlagValue> extends BaseFlag<T> {
  owner: "release";
  // YYYY-MM-DD. The flag and the code behind it are removed by then.
  removeBy: string;
}

export interface OpsFlag<T extends FlagValue = FlagValue> extends BaseFlag<T> {
  owner: "ops";
  removeBy?: string;
}

export type FlagDefinition<T extends FlagValue = FlagValue> = ReleaseFlag<T> | OpsFlag<T>;
export type FlagRegistry = Record<string, FlagDefinition>;

// Keeps each entry's literal type, so a flag's key and value type are
// checked where it's read.
export const defineFlags = <R extends FlagRegistry>(registry: R): R => registry;

export const flags = defineFlags({});

export type Flags = typeof flags;
export type FlagKey = keyof Flags & string;

// The environment variable that overrides a flag: upper case, words split
// at camelCase boundaries, anything else that isn't a letter or digit
// turned into "_". isPaymentRequired -> FLAG_IS_PAYMENT_REQUIRED,
// new-checkout -> FLAG_NEW_CHECKOUT.
export const overrideVariable = (key: string) =>
  `FLAG_${key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase()}`;

// What's wrong with a registry, if anything: release flags without a valid
// removeBy, and keys that map to the same override variable.
export const registryProblems = (registry: FlagRegistry): string[] => {
  const problems: string[] = [];
  const variables = new Map<string, string>();
  for (const [key, flag] of Object.entries(registry)) {
    if (flag.owner === "release" && !/^\d{4}-\d{2}-\d{2}$/.test(flag.removeBy ?? "")) {
      problems.push(`${key}: a release flag needs removeBy as YYYY-MM-DD`);
    }
    const variable = overrideVariable(key);
    const other = variables.get(variable);
    if (other) problems.push(`${key} and ${other} share the override variable ${variable}`);
    variables.set(variable, key);
  }
  return problems;
};

// Release flags whose removeBy is before `today` (YYYY-MM-DD).
export const expiredFlags = (registry: FlagRegistry, today: string): string[] =>
  Object.entries(registry)
    .filter(([, flag]) => flag.owner === "release" && flag.removeBy! < today)
    .map(([key]) => key);
