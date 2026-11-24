import { getRemoteConfig } from "firebase-admin/remote-config";
import { firebaseApp } from "#src/config/firestore";
import { logger } from "#src/utils/logger";
import { RemoteConfigProvider } from "./providers/remoteConfig.ts";
import type { DomainProviders } from "./setup.ts";

// The providers src/index.ts starts with: Remote Config for "ops".
// GrowthBook joins "release" in its own task.
//
// Remote Config has no emulator. With FIRESTORE_EMULATOR_HOST set (npm run
// dev:local, the e2e and emulator runs) the API isn't talking to a real
// project, so ops flags answer with their defaults and FLAG_<KEY> overrides.
export const productionProviders = (env: Record<string, string | undefined> = process.env): DomainProviders => {
  if (env.FIRESTORE_EMULATOR_HOST) {
    logger.info("Remote Config is off with the emulators; ops flags use their defaults and FLAG_<KEY> overrides");
    return {};
  }
  return { ops: [new RemoteConfigProvider(getRemoteConfig(firebaseApp).initServerTemplate())] };
};
