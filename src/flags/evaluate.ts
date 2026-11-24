import { OpenFeature, type EvaluationContext } from "@openfeature/server-sdk";
import type { Context } from "#src/context";
import type { FlagRegistry, FlagValue } from "./registry.ts";

// Who the flag is evaluated for, from the request's verified user.
// targetingKey is the uid: stable and not secret, so percentage rollouts keep
// a user in the same group. GrowthBook's provider doesn't copy targetingKey to
// the "id" attribute it splits percentages by, so id carries the uid too.
export const flagContext = ({ user }: Pick<Context, "user">): EvaluationContext => ({
  targetingKey: user.uid,
  id: user.uid,
  anonymous: user.firebase?.sign_in_provider === "anonymous",
});

type KeysOfType<R extends FlagRegistry, T> = { [K in keyof R & string]: R[K]["defaultValue"] extends T ? K : never }[keyof R &
  string];

export class UnknownFlagError extends Error {
  constructor(key: string) {
    super(`Unknown feature flag "${key}"; declare it in src/flags/registry.ts`);
    this.name = "UnknownFlagError";
  }
}

// isOn/valueOf for a registry. src/flags/index.ts binds it to the real one;
// tests bind it to their own.
export const createFlags = <R extends FlagRegistry>(registry: R) => {
  const definition = (key: string) => {
    const flag = Object.hasOwn(registry, key) ? registry[key] : undefined;
    if (!flag) throw new UnknownFlagError(key);
    return flag;
  };

  // The domain is the flag's owner, so a release flag is never answered by
  // Remote Config or an ops flag by GrowthBook.
  const evaluate = async (key: string, ctx: Pick<Context, "user">): Promise<FlagValue> => {
    const flag = definition(key);
    const client = OpenFeature.getClient(flag.owner);
    const context = flagContext(ctx);
    switch (typeof flag.defaultValue) {
      case "boolean":
        return client.getBooleanValue(key, flag.defaultValue, context);
      case "number":
        return client.getNumberValue(key, flag.defaultValue, context);
      default:
        return client.getStringValue(key, flag.defaultValue, context);
    }
  };

  return {
    isOn: async (key: KeysOfType<R, boolean>, ctx: Pick<Context, "user">) => (await evaluate(key, ctx)) === true,
    valueOf: async <K extends keyof R & string>(key: K, ctx: Pick<Context, "user">) =>
      (await evaluate(key, ctx)) as R[K]["defaultValue"],
  };
};
