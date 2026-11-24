import { afterEach, describe, expect, it, vi } from "vitest";
import { getRemoteConfig } from "firebase-admin/remote-config";
import { firebaseApp } from "../src/config/firestore.js";
import { closeFlags, setupFlags } from "../src/flags/setup.js";
import { flags } from "../src/flags/registry.js";
import { createFlags } from "../src/flags/evaluate.js";
import { productionProviders } from "../src/flags/production.js";
import { RemoteConfigProvider, remoteConfigContext } from "../src/flags/providers/remoteConfig.js";

const { valueOf } = createFlags(flags);
const user = { user: { uid: "user-1", firebase: { sign_in_provider: "password" } } };

const testAccountCondition = {
  name: "test accounts",
  condition: {
    orCondition: {
      conditions: [
        {
          andCondition: {
            conditions: [
              {
                customSignal: {
                  customSignalOperator: "STRING_EXACTLY_MATCHES",
                  customSignalKey: "testAccount",
                  targetCustomSignalValues: ["true"],
                },
              },
            ],
          },
        },
      ],
    },
  },
};

const templateWith = (parameters, conditions = []) => ({ conditions, parameters, etag: "etag-test" });

// firebase-admin's real server template, filled in memory: evaluation and
// conditions behave as in production, and only load() (the network call) is
// faked.
const fakeTemplate = (data) => {
  const template = getRemoteConfig(firebaseApp).initServerTemplate();
  const source = {
    load: vi.fn(async () => template.set(source.data)),
    evaluate: (context) => template.evaluate(context),
    toJSON: () => template.toJSON(),
    data,
  };
  return source;
};

const logs = () => {
  const writes = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return () => writes.mock.calls.map(([line]) => JSON.parse(line));
};

afterEach(async () => {
  await closeFlags();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Remote Config provider", () => {
  it("answers with the template's value for a string parameter", async () => {
    const provider = new RemoteConfigProvider(
      fakeTemplate(templateWith({ checkout_banner: { defaultValue: { value: "Free shipping today" }, valueType: "STRING" } }))
    );
    await provider.initialize();

    expect(await provider.resolveStringEvaluation("checkout_banner", "", {})).toEqual({
      value: "Free shipping today",
      reason: "STATIC",
    });
    await provider.onClose();
  });

  it.each([
    ["boolean", "BOOLEAN", "true", true, "resolveBooleanEvaluation", false],
    ["number", "NUMBER", "25", 25, "resolveNumberEvaluation", 0],
    ["JSON", "JSON", '{"a":1}', { a: 1 }, "resolveObjectEvaluation", {}],
  ])("maps a %s parameter", async (_name, valueType, raw, expected, method, fallback) => {
    const provider = new RemoteConfigProvider(fakeTemplate(templateWith({ p: { defaultValue: { value: raw }, valueType } })));
    await provider.initialize();

    expect((await provider[method]("p", fallback, {})).value).toEqual(expected);
    await provider.onClose();
  });

  it("answers FLAG_NOT_FOUND for a key that isn't in the template, or that uses the in-app default", async () => {
    const provider = new RemoteConfigProvider(
      fakeTemplate(templateWith({ in_app: { defaultValue: { useInAppDefault: true }, valueType: "STRING" } }))
    );
    await provider.initialize();

    await expect(provider.resolveStringEvaluation("checkout_banner", "", {})).rejects.toMatchObject({
      code: "FLAG_NOT_FOUND",
    });
    await expect(provider.resolveStringEvaluation("in_app", "", {})).rejects.toMatchObject({ code: "FLAG_NOT_FOUND" });
    await provider.onClose();
  });

  it("answers TYPE_MISMATCH when the parameter's type isn't the flag's", async () => {
    const provider = new RemoteConfigProvider(
      fakeTemplate(templateWith({ checkout_banner: { defaultValue: { value: "true" }, valueType: "BOOLEAN" } }))
    );
    await provider.initialize();

    await expect(provider.resolveStringEvaluation("checkout_banner", "", {})).rejects.toMatchObject({
      code: "TYPE_MISMATCH",
    });
    await provider.onClose();
  });

  // The Remote Config API returns server templates without valueType, so the
  // value itself has to be of the flag's type.
  it("checks the value itself when the template has no valueType, as production's doesn't", async () => {
    const provider = new RemoteConfigProvider(
      fakeTemplate(
        templateWith({
          flag_off: { defaultValue: { value: "false" } },
          flag_yes: { defaultValue: { value: "yes" } },
          limit: { defaultValue: { value: "12" } },
          limit_text: { defaultValue: { value: "twelve" } },
          banner: { defaultValue: { value: "true" } },
        })
      )
    );
    await provider.initialize();

    expect((await provider.resolveBooleanEvaluation("flag_off", true, {})).value).toBe(false);
    expect((await provider.resolveNumberEvaluation("limit", 0, {})).value).toBe(12);
    expect((await provider.resolveStringEvaluation("banner", "", {})).value).toBe("true");
    await expect(provider.resolveBooleanEvaluation("flag_yes", false, {})).rejects.toMatchObject({ code: "TYPE_MISMATCH" });
    await expect(provider.resolveNumberEvaluation("limit_text", 0, {})).rejects.toMatchObject({ code: "TYPE_MISMATCH" });
    await provider.onClose();
  });

  it("applies conditions with the evaluation context as custom signals", async () => {
    const provider = new RemoteConfigProvider(
      fakeTemplate(
        templateWith(
          {
            is_payment_required: {
              defaultValue: { value: "true" },
              conditionalValues: { "test accounts": { value: "false" } },
              valueType: "BOOLEAN",
            },
          },
          [testAccountCondition]
        )
      )
    );
    await provider.initialize();

    const testAccount = await provider.resolveBooleanEvaluation("is_payment_required", true, {
      targetingKey: "u1",
      testAccount: true,
    });
    const regular = await provider.resolveBooleanEvaluation("is_payment_required", true, { targetingKey: "u2" });

    expect(testAccount).toEqual({ value: false, reason: "TARGETING_MATCH" });
    expect(regular.value).toBe(true);
    await provider.onClose();
  });

  it("sends strings and numbers as they are, booleans as text and the uid as randomizationId", () => {
    expect(remoteConfigContext({ targetingKey: "u1", id: "u1", anonymous: false, age: 3, tags: ["x"] })).toEqual({
      id: "u1",
      anonymous: "false",
      age: 3,
      randomizationId: "u1",
    });
  });

  it("answers GENERAL until the first template loads, and the API starts anyway", async () => {
    const read = logs();
    const template = fakeTemplate(templateWith({}));
    template.load.mockRejectedValue(new Error("PERMISSION_DENIED"));
    const provider = new RemoteConfigProvider(template);

    await provider.initialize();

    await expect(provider.resolveStringEvaluation("checkout_banner", "", {})).rejects.toMatchObject({ code: "GENERAL" });
    expect(read().find((entry) => entry.message.startsWith("Couldn't load the Remote Config template"))).toMatchObject({
      severity: "WARNING",
      error: "PERMISSION_DENIED",
      loadedBefore: false,
    });
    await provider.onClose();
  });

  it("reloads on a timer, keeps the last template when a reload fails and logs the failure once", async () => {
    vi.useFakeTimers();
    const read = logs();
    const template = fakeTemplate(
      templateWith({ checkout_banner: { defaultValue: { value: "first" }, valueType: "STRING" } })
    );
    const provider = new RemoteConfigProvider(template, 1000);
    await provider.initialize();

    template.data = templateWith({ checkout_banner: { defaultValue: { value: "second" }, valueType: "STRING" } });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await provider.resolveStringEvaluation("checkout_banner", "", {})).value).toBe("second");

    template.load.mockRejectedValue(new Error("UNAVAILABLE"));
    await vi.advanceTimersByTimeAsync(3000);
    expect((await provider.resolveStringEvaluation("checkout_banner", "", {})).value).toBe("second");
    expect(read().filter((entry) => entry.message.startsWith("Couldn't load"))).toHaveLength(1);

    template.load.mockImplementation(async () => {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(read().some((entry) => entry.message === "Remote Config template loaded again")).toBe(true);

    await provider.onClose();
    const calls = template.load.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(template.load.mock.calls.length).toBe(calls);
  });
});

describe("checkout_banner through the ops domain", () => {
  const banner = (value) =>
    new RemoteConfigProvider(
      fakeTemplate(templateWith({ checkout_banner: { defaultValue: { value }, valueType: "STRING" } }))
    );

  it("reads the value from Remote Config", async () => {
    await setupFlags({ env: {}, providers: { ops: [banner("Sale ends tonight")] } });

    expect(await valueOf("checkout_banner", user)).toBe("Sale ends tonight");
  });

  it("FLAG_CHECKOUT_BANNER wins over Remote Config", async () => {
    await setupFlags({ env: { FLAG_CHECKOUT_BANNER: "Maintenance at 22:00" }, providers: { ops: [banner("Sale")] } });

    expect(await valueOf("checkout_banner", user)).toBe("Maintenance at 22:00");
  });

  it("falls back to the empty default when Remote Config doesn't have it or has the wrong type", async () => {
    const wrongType = new RemoteConfigProvider(
      fakeTemplate(templateWith({ checkout_banner: { defaultValue: { value: "1" }, valueType: "NUMBER" } }))
    );
    await setupFlags({ env: {}, providers: { ops: [wrongType] } });
    expect(await valueOf("checkout_banner", user)).toBe("");

    await closeFlags();
    await setupFlags({ env: {}, providers: { ops: [new RemoteConfigProvider(fakeTemplate(templateWith({})))] } });
    expect(await valueOf("checkout_banner", user)).toBe("");
  });
});

describe("production providers", () => {
  it("leaves Remote Config out when running against the emulators", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(productionProviders({ FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" })).toEqual({});
  });

  it("serves the ops domain from Remote Config against a real project", () => {
    const providers = productionProviders({});
    expect(providers.ops).toHaveLength(1);
    expect(providers.ops[0]).toBeInstanceOf(RemoteConfigProvider);
    expect(providers.release).toBeUndefined();
  });
});
