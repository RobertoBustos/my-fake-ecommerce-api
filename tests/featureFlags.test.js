import { afterEach, describe, expect, it, vi } from "vitest";
import { ESLint } from "eslint";
import { InMemoryProvider } from "@openfeature/server-sdk";
import { createFlags, flagContext, UnknownFlagError } from "../src/flags/evaluate.js";
import { setupFlags, closeFlags } from "../src/flags/setup.js";
import { EnvOverrideProvider } from "../src/flags/providers/envOverride.js";
import { defineFlags, expiredFlags, flags, overrideVariable, registryProblems } from "../src/flags/registry.js";

// A registry of its own, so the tests don't depend on which real flags exist.
const testFlags = defineFlags({
  newCheckout: {
    owner: "release",
    defaultValue: false,
    description: "Test release flag",
    responsible: "tests",
    removeBy: "2099-01-01",
  },
  cartItemLimit: { owner: "ops", defaultValue: 50, description: "Test ops flag", responsible: "tests" },
  bannerText: { owner: "ops", defaultValue: "hello", description: "Test string flag", responsible: "tests" },
});
const { isOn, valueOf } = createFlags(testFlags);

const anonymousUser = { user: { uid: "anon-1", firebase: { sign_in_provider: "anonymous" } } };
const signedInUser = { user: { uid: "user-1", firebase: { sign_in_provider: "password" } } };

// The remote tool, stood in for by OpenFeature's in-memory provider.
const remote = (values) =>
  new InMemoryProvider(
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        { variants: { on: value }, defaultVariant: "on", disabled: false },
      ])
    )
  );

afterEach(async () => {
  await closeFlags();
  vi.restoreAllMocks();
});

describe("feature flags", () => {
  it("answers with the registry default when nothing overrides it", async () => {
    await setupFlags({ env: {} });

    expect(await isOn("newCheckout", signedInUser)).toBe(false);
    expect(await valueOf("cartItemLimit", signedInUser)).toBe(50);
    expect(await valueOf("bannerText", signedInUser)).toBe("hello");
  });

  it("FLAG_<KEY> overrides a flag of each type", async () => {
    await setupFlags({
      env: { FLAG_NEW_CHECKOUT: "true", FLAG_CART_ITEM_LIMIT: "10", FLAG_BANNER_TEXT: "sale" },
    });

    expect(await isOn("newCheckout", signedInUser)).toBe(true);
    expect(await valueOf("cartItemLimit", signedInUser)).toBe(10);
    expect(await valueOf("bannerText", signedInUser)).toBe("sale");
  });

  it("the override wins over the domain's tool, and the tool answers when there's no override", async () => {
    await setupFlags({
      env: { FLAG_NEW_CHECKOUT: "false" },
      providers: { release: [remote({ newCheckout: true })], ops: [remote({ cartItemLimit: 99 })] },
    });

    expect(await isOn("newCheckout", signedInUser)).toBe(false);
    expect(await valueOf("cartItemLimit", signedInUser)).toBe(99);
  });

  it("asks only the flag owner's tool", async () => {
    // The ops tool knows a key with the release flag's name; it must not answer it.
    await setupFlags({ env: {}, providers: { ops: [remote({ newCheckout: true })] } });

    expect(await isOn("newCheckout", signedInUser)).toBe(false);
  });

  it.each([
    ["FLAG_NEW_CHECKOUT", "yes", "boolean"],
    ["FLAG_CART_ITEM_LIMIT", "ten", "number"],
  ])("ignores %s=%s with a WARNING and falls through", async (variable, value, expected) => {
    const writes = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await setupFlags({ env: { [variable]: value } });

    expect(await isOn("newCheckout", signedInUser)).toBe(false);
    expect(await valueOf("cartItemLimit", signedInUser)).toBe(50);

    const warning = writes.mock.calls
      .map(([line]) => JSON.parse(line))
      .find((entry) => entry.message?.startsWith("Ignoring a flag override"));
    expect(warning).toMatchObject({ severity: "WARNING", variable, expected });
  });

  it("refuses a flag that isn't in the registry", async () => {
    await setupFlags({ env: { FLAG_NOT_DECLARED: "true" } });

    await expect(isOn("notDeclared", signedInUser)).rejects.toBeInstanceOf(UnknownFlagError);
    await expect(valueOf("notDeclared", signedInUser)).rejects.toThrow(/declare it in src\/flags\/registry\.ts/);
  });

  it("answers with the defaults before setup has run", async () => {
    expect(await isOn("newCheckout", signedInUser)).toBe(false);
    expect(await valueOf("cartItemLimit", signedInUser)).toBe(50);
  });

  it("starts on the defaults when a provider takes longer than the wait", async () => {
    const slow = remote({ cartItemLimit: 99 });
    slow.initialize = () => new Promise((resolve) => setTimeout(resolve, 500));
    const writes = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const started = Date.now();
    await setupFlags({ env: {}, providers: { ops: [slow] }, waitMs: 50 });

    expect(Date.now() - started).toBeLessThan(400);
    expect(writes.mock.calls.some(([line]) => line.includes("aren't ready yet"))).toBe(true);
  });
});

describe("evaluation context", () => {
  it("targets by uid, also as id for GrowthBook's percentage splits, and says whether the user is anonymous", () => {
    expect(flagContext(signedInUser)).toEqual({ targetingKey: "user-1", id: "user-1", anonymous: false });
    expect(flagContext(anonymousUser)).toEqual({ targetingKey: "anon-1", id: "anon-1", anonymous: true });
  });

  it("passes that context to the tool", async () => {
    const tool = remote({ newCheckout: true });
    const resolve = vi.spyOn(tool, "resolveBooleanEvaluation");
    await setupFlags({ env: {}, providers: { release: [tool] } });

    await isOn("newCheckout", anonymousUser);

    expect(resolve.mock.calls[0][2]).toMatchObject({ targetingKey: "anon-1", id: "anon-1", anonymous: true });
  });
});

describe("override variable names", () => {
  it.each([
    ["isPaymentRequired", "FLAG_IS_PAYMENT_REQUIRED"],
    ["new-checkout", "FLAG_NEW_CHECKOUT"],
    ["cart.item_limit", "FLAG_CART_ITEM_LIMIT"],
    ["v2Search", "FLAG_V2_SEARCH"],
  ])("%s -> %s", (key, variable) => {
    expect(overrideVariable(key)).toBe(variable);
  });

  it("reads only its own variable", async () => {
    const provider = new EnvOverrideProvider({ FLAG_OTHER: "true" });
    await expect(provider.resolveBooleanEvaluation("newCheckout")).rejects.toMatchObject({ code: "FLAG_NOT_FOUND" });
  });
});

describe("the registry", () => {
  it("has no problems: release flags have a removeBy and no two keys share an override variable", () => {
    expect(registryProblems(flags)).toEqual([]);
  });

  it("has no release flag past its removeBy date; remove the flag and the code behind it", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(expiredFlags(flags, today)).toEqual([]);
  });

  it("catches what the checks above look for", () => {
    const bad = {
      oldRollout: { owner: "release", defaultValue: false, description: "", responsible: "", removeBy: "2026-01-01" },
      noDate: { owner: "release", defaultValue: false, description: "", responsible: "" },
      "new-checkout": { owner: "ops", defaultValue: false, description: "", responsible: "" },
      newCheckout: { owner: "ops", defaultValue: false, description: "", responsible: "" },
    };

    expect(expiredFlags(bad, "2026-11-23")).toEqual(["oldRollout"]);
    expect(registryProblems(bad)).toEqual([
      "noDate: a release flag needs removeBy as YYYY-MM-DD",
      "newCheckout and new-checkout share the override variable FLAG_NEW_CHECKOUT",
    ]);
  });
});

describe("Feature flag SDKs stay in src/flags/", () => {
  const eslint = new ESLint();
  const restricted = async (filePath, specifier) => {
    const [result] = await eslint.lintText(`import x from "${specifier}";\nexport const y = x;\n`, { filePath });
    return result.messages.filter((message) => message.ruleId === "no-restricted-imports");
  };

  it.each([
    ["src/services/orderService.ts", "@openfeature/server-sdk"],
    ["src/schema/resolvers/mutations.ts", "@openfeature/server-sdk"],
    ["src/catalog/catalogSync.ts", "@growthbook/growthbook"],
    ["src/jobs/someJob.ts", "firebase-admin/remote-config"],
    ["src/observability/flags.ts", "@openfeature/core"],
    ["src/search/adapters/algolia/flags.ts", "@openfeature/server-sdk"],
    ["scripts/someScript.ts", "@openfeature/server-sdk"],
  ])("rejects %s importing %s", async (filePath, specifier) => {
    const messages = await restricted(filePath, specifier);
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatch(/Only src\/flags\/ may use a feature flag SDK/);
  });

  it.each([
    ["src/flags/setup.ts", "@openfeature/server-sdk"],
    ["src/flags/providers/remoteConfig.ts", "firebase-admin/remote-config"],
    ["src/services/orderService.ts", "#src/flags"],
  ])("allows %s importing %s", async (filePath, specifier) => {
    expect(await restricted(filePath, specifier)).toEqual([]);
  });

  it("keeps the other layer rules inside src/flags/", async () => {
    expect(await restricted("src/flags/setup.ts", "@opentelemetry/api")).toHaveLength(1);
  });
});
