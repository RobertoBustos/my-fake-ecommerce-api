import {
  FlagNotFoundError,
  StandardResolutionReasons,
  type JsonValue,
  type Provider,
  type ResolutionDetails,
} from "@openfeature/server-sdk";
import { logger } from "#src/utils/logger";
import { overrideVariable } from "#src/flags/registry";

type Env = Record<string, string | undefined>;

// Answers first in both domains: FLAG_<KEY>, when it's set, wins over
// whatever the remote tool says. It's for turning a flag during an incident
// or in local development; normally none is set.
//
// With no variable it throws FLAG_NOT_FOUND, which the Multi-Provider's
// FirstMatchStrategy takes as "ask the next provider". A value that doesn't
// parse as the flag's type is ignored the same way, with a WARNING, so a typo
// can't take a flag down.
export class EnvOverrideProvider implements Provider {
  readonly metadata = { name: "env-override" } as const;
  readonly runsOn = "server" as const;

  constructor(private readonly env: Env = process.env) {}

  private resolve<T extends JsonValue>(
    flagKey: string,
    type: string,
    parse: (raw: string) => T | undefined
  ): ResolutionDetails<T> {
    const variable = overrideVariable(flagKey);
    const raw = this.env[variable];
    if (raw === undefined || raw === "") throw new FlagNotFoundError(`${variable} is not set`);

    const value = parse(raw.trim());
    if (value === undefined) {
      logger.warn("Ignoring a flag override that isn't valid for the flag's type", {
        flag: flagKey,
        variable,
        expected: type,
      });
      throw new FlagNotFoundError(`${variable} is not a valid ${type}`);
    }
    return { value, reason: StandardResolutionReasons.STATIC, variant: "env-override" };
  }

  async resolveBooleanEvaluation(flagKey: string) {
    return this.resolve(flagKey, "boolean", (raw) => {
      const lower = raw.toLowerCase();
      return lower === "true" ? true : lower === "false" ? false : undefined;
    });
  }

  async resolveStringEvaluation(flagKey: string) {
    return this.resolve(flagKey, "string", (raw) => raw);
  }

  async resolveNumberEvaluation(flagKey: string) {
    return this.resolve(flagKey, "number", (raw) => {
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    });
  }

  async resolveObjectEvaluation<T extends JsonValue>(flagKey: string) {
    return this.resolve<T>(flagKey, "JSON", (raw) => {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    });
  }
}
