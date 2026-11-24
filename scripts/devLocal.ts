import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { networkInterfaces } from "os";
import { fileURLToPath } from "url";
import { parseArgs, parseEnv } from "util";

// npm run dev:local: the Firestore and Auth emulators, the sample catalog and
// the API with reload, in one command. Ctrl+C stops all of it.
//
// It only ever writes to the emulators. The values below win over .env
// (a variable already in the environment beats one from --env-file), so a
// .env that points at a real project can't make it write anywhere else.
//
// --auth-project <id>: for a phone running the real app, which signs in with
// that Firebase project and can't use the Auth emulator. The API verifies
// that project's tokens instead of the emulator's and listens on the network
// (0.0.0.0) so the phone can reach it. Firestore stays on the emulator and the
// Stripe key must still be a test key.

export const DEMO_PROJECT = "demo-ecommerce-api";
const FIRESTORE_HOST = "127.0.0.1:8080";
const AUTH_HOST = "127.0.0.1:9099";

type Env = Record<string, string | undefined>;

export interface DevLocalOptions {
  // The Firebase project whose ID tokens the API accepts, instead of the Auth
  // emulator's.
  authProject?: string;
}

// Firebase project ids: 6 to 30 lowercase letters, digits and hyphens.
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export const parseDevLocalArgs = (args: string[]): DevLocalOptions => {
  const { values } = parseArgs({ args, options: { "auth-project": { type: "string" } } });
  const authProject = values["auth-project"];
  if (authProject === undefined) return {};
  if (!PROJECT_ID.test(authProject)) {
    throw new Error(`--auth-project needs a Firebase project id (got "${authProject}").`);
  }
  if (authProject.startsWith("demo-")) {
    throw new Error("--auth-project is for a real project's tokens; demo projects already use the Auth emulator.");
  }
  return { authProject };
};

// The environment the emulators, the seed and the API run with. `shell` is
// the caller's environment and `file` what .env defines.
export const devLocalEnv = (shell: Env, file: Env = {}, { authProject }: DevLocalOptions = {}): Env => {
  const pick = (name: string, fallback: string) => shell[name] || file[name] || fallback;

  const stripeKey = pick("STRIPE_SECRET_KEY", "");
  if (stripeKey.startsWith("sk_live_") || stripeKey.startsWith("rk_live_")) {
    throw new Error("STRIPE_SECRET_KEY is a live key; dev:local only runs with a test key (sk_test_...).");
  }

  return {
    ...shell,
    // firebase-admin's project: the demo one, or the app's with
    // --auth-project. Either way FIRESTORE_EMULATOR_HOST is set, so Firestore
    // reads and writes only ever reach the emulator.
    FIRESTORE_PROJECT_ID: authProject ?? DEMO_PROJECT,
    GCLOUD_PROJECT: authProject ?? DEMO_PROJECT,
    FIRESTORE_EMULATOR_HOST: FIRESTORE_HOST,
    // Empty rather than removed with --auth-project: an empty variable still
    // beats the one in .env, and firebase-admin treats it as unset, so tokens
    // are verified against the real project.
    FIREBASE_AUTH_EMULATOR_HOST: authProject ? "" : AUTH_HOST,
    // The in-memory index, so a hosted search index is never written to.
    SEARCH_ENGINE: "memory",
    // Not the image defaults (0.0.0.0:8080): 8080 is the Firestore emulator.
    // A phone needs the API on the network, so --auth-project listens on all
    // interfaces unless HOST says otherwise.
    HOST: pick("HOST", authProject ? "0.0.0.0" : "localhost"),
    PORT: pick("PORT", "4000"),
  };
};

// With --auth-project only Firestore is emulated: emulators:exec would
// otherwise set FIREBASE_AUTH_EMULATOR_HOST for the command again.
export const emulatorsFor = ({ authProject }: DevLocalOptions) => (authProject ? "firestore" : "firestore,auth");

// The laptop's addresses on the local network, for the app's API URL.
const lanAddresses = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((address) => address && address.family === "IPv4" && !address.internal)
    .map((address) => address!.address);

// What runs once the emulators answer: the seed, then the API under
// `tsx watch`, which restarts it when a source file changes.
export const DEV_COMMAND = "tsx scripts/seedFirestore.ts && tsx watch --env-file-if-exists=.env src/index.ts";

const readDotEnv = (path: string): Env => (existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {});

const main = () => {
  let options: DevLocalOptions;
  let env: Env;
  try {
    options = parseDevLocalArgs(process.argv.slice(2));
    env = devLocalEnv(process.env, readDotEnv(".env"), options);
  } catch (err) {
    console.error(`dev:local: ${(err as Error).message}`);
    process.exit(1);
  }

  if (options.authProject) {
    const urls = lanAddresses().map((ip) => `http://${ip}:${env.PORT}/graphql`);
    console.log(
      `dev:local: Firestore emulator on ${FIRESTORE_HOST}; the API accepts ID tokens from ${options.authProject} ` +
        `and listens on ${env.HOST}:${env.PORT}.\n` +
        (urls.length ? `  From a phone on this network: EXPO_PUBLIC_API_URL=${urls.join(" or ")}` : "  No network address found.")
    );
  } else {
    console.log(
      `dev:local: emulators on ${FIRESTORE_HOST} (Firestore) and ${AUTH_HOST} (Auth), ` +
        `API on http://${env.HOST}:${env.PORT}/graphql. Get a token with \`npm run token:local\`.`
    );
  }

  // emulators:exec waits until the emulators answer, runs the command, and
  // shuts the emulators down when it ends.
  const child = spawn(
    "firebase",
    ["emulators:exec", "--only", emulatorsFor(options), "--project", DEMO_PROJECT, DEV_COMMAND],
    { env, stdio: "inherit" }
  );

  // Ctrl+C reaches every process in the terminal's group, the emulators and
  // the API included; this one waits for them to exit instead of leaving
  // them behind on their ports.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  child.on("error", (err) => {
    console.error("dev:local: couldn't start the Firebase CLI. Run it through npm (npm run dev:local).", err);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 130 : 1)));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
