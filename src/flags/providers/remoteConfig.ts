import {
  FlagNotFoundError,
  GeneralError,
  StandardResolutionReasons,
  TypeMismatchError,
  type EvaluationContext,
  type JsonValue,
  type Provider,
  type ResolutionDetails,
} from "@openfeature/server-sdk";
import type {
  EvaluationContext as RemoteConfigContext,
  ParameterValueType,
  ServerTemplate,
} from "firebase-admin/remote-config";
import { logger } from "#src/utils/logger";

// How often the template is downloaded again. Each load is one request to
// the Remote Config API (quota: 2,000 per minute per project), so 5
// instances use 5 a minute.
export const RELOAD_MS = 60_000;

// The part of firebase-admin's ServerTemplate the provider uses, so tests can
// pass a fake one.
export type TemplateSource = Pick<ServerTemplate, "load" | "evaluate" | "toJSON">;

// Remote Config's custom signals only take strings and numbers: booleans go
// as "true"/"false" (a server condition matches them with
// STRING_EXACTLY_MATCHES), anything else is left out. The uid goes as
// randomizationId, which percentage conditions split by.
export const remoteConfigContext = (context: EvaluationContext): RemoteConfigContext => {
  const signals: RemoteConfigContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (key === "targetingKey") continue;
    if (typeof value === "string" || typeof value === "number") signals[key] = value;
    else if (typeof value === "boolean") signals[key] = String(value);
  }
  if (context.targetingKey) signals.randomizationId = context.targetingKey;
  return signals;
};

// Serves the "ops" domain from a Remote Config server template. Firebase
// doesn't publish an OpenFeature provider, so this is ours.
//
// It loads the template at startup and every RELOAD_MS after that. A load
// that fails is logged and the last template stays in use; before the first
// successful load, evaluations fail with GENERAL, which makes OpenFeature
// answer with the registry default.
//
// A key that isn't in the template (or whose value is "use in-app default")
// answers FLAG_NOT_FOUND, so the registry default applies. A value that isn't
// of the flag's type answers TYPE_MISMATCH, so a wrongly typed parameter
// can't turn into a wrong value. The server template the Remote Config API
// returns has no valueType (checked against the production template on
// 24 Nov 2026), so the type is checked by parsing the value; a valueType,
// when present, has to match too.
export class RemoteConfigProvider implements Provider {
  readonly metadata = { name: "remote-config" } as const;
  readonly runsOn = "server" as const;

  private timer: NodeJS.Timeout | undefined;
  private loaded = false;
  private failing = false;

  constructor(
    private readonly template: TemplateSource,
    private readonly reloadMs = RELOAD_MS
  ) {}

  async initialize() {
    await this.reload();
    // unref: the timer must not keep the process alive during shutdown.
    this.timer = setInterval(() => void this.reload(), this.reloadMs);
    this.timer.unref();
  }

  async onClose() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // Logs once when loading starts failing and once when it recovers, not
  // every minute while it's down.
  private async reload() {
    try {
      await this.template.load();
      this.loaded = true;
      if (this.failing) logger.info("Remote Config template loaded again");
      this.failing = false;
    } catch (err) {
      if (!this.failing) {
        logger.warn("Couldn't load the Remote Config template; keeping the last one", {
          error: (err as Error).message,
          loadedBefore: this.loaded,
        });
      }
      this.failing = true;
    }
  }

  // `read` returns undefined when the raw value isn't of the flag's type.
  private resolve<T extends JsonValue>(
    flagKey: string,
    expected: ParameterValueType,
    context: EvaluationContext,
    read: (raw: string) => T | undefined
  ): ResolutionDetails<T> {
    if (!this.loaded) throw new GeneralError("The Remote Config template hasn't loaded yet");

    const parameter = this.template.toJSON().parameters[flagKey];
    const value = this.template.evaluate(remoteConfigContext(context)).getValue(flagKey);
    if (!parameter || value.getSource() !== "remote") {
      throw new FlagNotFoundError(`${flagKey} isn't in the Remote Config template`);
    }

    if (parameter.valueType && parameter.valueType !== expected) {
      throw new TypeMismatchError(`${flagKey} is ${parameter.valueType} in Remote Config; the flag expects ${expected}`);
    }
    const parsed = read(value.asString());
    if (parsed === undefined) {
      throw new TypeMismatchError(`${flagKey}'s value in Remote Config isn't a valid ${expected}`);
    }

    return {
      value: parsed,
      // The template doesn't say which condition matched; a parameter with
      // conditional values was at least evaluated against them.
      reason: parameter.conditionalValues
        ? StandardResolutionReasons.TARGETING_MATCH
        : StandardResolutionReasons.STATIC,
    };
  }

  async resolveBooleanEvaluation(flagKey: string, _default: boolean, context: EvaluationContext) {
    return this.resolve(flagKey, "BOOLEAN", context, (raw) =>
      raw === "true" ? true : raw === "false" ? false : undefined
    );
  }

  async resolveStringEvaluation(flagKey: string, _default: string, context: EvaluationContext) {
    return this.resolve(flagKey, "STRING", context, (raw) => raw);
  }

  async resolveNumberEvaluation(flagKey: string, _default: number, context: EvaluationContext) {
    return this.resolve(flagKey, "NUMBER", context, (raw) => {
      const value = raw.trim() === "" ? NaN : Number(raw);
      return Number.isFinite(value) ? value : undefined;
    });
  }

  async resolveObjectEvaluation<T extends JsonValue>(flagKey: string, _default: T, context: EvaluationContext) {
    return this.resolve<T>(flagKey, "JSON", context, (raw) => {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    });
  }
}
