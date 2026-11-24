import { FirstMatchStrategy, MultiProvider, OpenFeature, type Provider } from "@openfeature/server-sdk";
import { logger } from "#src/utils/logger";
import { EnvOverrideProvider } from "./providers/envOverride.ts";
import type { FlagOwner } from "./registry.ts";

// Cloud Run starts instances cold (minScale 0). Waiting for GrowthBook or
// Remote Config with no limit would make every cold start that much longer,
// so setup waits this long at most; past it the API starts on the registry
// defaults and the providers finish loading in the background.
export const STARTUP_WAIT_MS = 2000;

// The providers behind the env override in each domain, in order. The
// provider tasks add GrowthBook to "release" and Remote Config to "ops".
export type DomainProviders = Partial<Record<FlagOwner, Provider[]>>;

const DOMAINS: FlagOwner[] = ["release", "ops"];

const domainProvider = (providers: Provider[], env: Record<string, string | undefined>) =>
  new MultiProvider(
    [new EnvOverrideProvider(env), ...providers].map((provider) => ({ provider })),
    new FirstMatchStrategy()
  );

// One OpenFeature domain per owner, each a Multi-Provider that asks the env
// override first and then the domain's tool. src/index.ts calls it before
// listening.
export const setupFlags = async ({
  providers = {},
  env = process.env,
  waitMs = STARTUP_WAIT_MS,
}: { providers?: DomainProviders; env?: Record<string, string | undefined>; waitMs?: number } = {}) => {
  const ready = Promise.all(
    DOMAINS.map((domain) => OpenFeature.setProviderAndWait(domain, domainProvider(providers[domain] ?? [], env)))
  ).then(() => true);

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), waitMs);
  });

  try {
    const loaded = await Promise.race([ready, timeout]);
    if (!loaded) logger.warn("Feature flag providers aren't ready yet; starting on the registry defaults", { waitMs });
  } catch (err) {
    // A provider that fails to start leaves its flags on the defaults; the
    // API still starts.
    logger.warn("A feature flag provider failed to start; its flags use the registry defaults", {
      error: (err as Error).message,
    });
  } finally {
    clearTimeout(timer);
  }
};

// Stops the providers' refreshes. src/shutdown.ts calls it.
export const closeFlags = () => OpenFeature.close();
