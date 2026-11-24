import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { parseEnv } from "util";

// npm run dev:local: the Firestore and Auth emulators, the sample catalog and
// the API with reload, in one command. Ctrl+C stops all of it.
//
// It only ever runs against the emulators. The values below win over .env
// (a variable already in the environment beats one from --env-file), so a
// .env that points at a real project can't make it write anywhere else.

export const DEMO_PROJECT = "demo-ecommerce-api";
const FIRESTORE_HOST = "127.0.0.1:8080";
const AUTH_HOST = "127.0.0.1:9099";

type Env = Record<string, string | undefined>;

// The environment the emulators, the seed and the API run with. `shell` is
// the caller's environment and `file` what .env defines.
export const devLocalEnv = (shell: Env, file: Env = {}): Env => {
  const pick = (name: string, fallback: string) => shell[name] || file[name] || fallback;

  const stripeKey = pick("STRIPE_SECRET_KEY", "");
  if (stripeKey.startsWith("sk_live_") || stripeKey.startsWith("rk_live_")) {
    throw new Error("STRIPE_SECRET_KEY is a live key; dev:local only runs with a test key (sk_test_...).");
  }

  return {
    ...shell,
    // Never a real project: firebase-admin talks to the emulators only.
    FIRESTORE_PROJECT_ID: DEMO_PROJECT,
    GCLOUD_PROJECT: DEMO_PROJECT,
    FIRESTORE_EMULATOR_HOST: FIRESTORE_HOST,
    FIREBASE_AUTH_EMULATOR_HOST: AUTH_HOST,
    // The in-memory index, so a hosted search index is never written to.
    SEARCH_ENGINE: "memory",
    // Not the image defaults (0.0.0.0:8080): 8080 is the Firestore emulator.
    HOST: pick("HOST", "localhost"),
    PORT: pick("PORT", "4000"),
  };
};

// What runs once the emulators answer: the seed, then the API under
// `tsx watch`, which restarts it when a source file changes.
export const DEV_COMMAND = "tsx scripts/seedFirestore.ts && tsx watch --env-file-if-exists=.env src/index.ts";

const readDotEnv = (path: string): Env => (existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {});

const main = () => {
  const env = devLocalEnv(process.env, readDotEnv(".env"));
  console.log(
    `dev:local: emulators on ${FIRESTORE_HOST} (Firestore) and ${AUTH_HOST} (Auth), ` +
      `API on http://${env.HOST}:${env.PORT}/graphql. Get a token with \`npm run token:local\`.`
  );

  // emulators:exec waits until the emulators answer, runs the command, and
  // shuts the emulators down when it ends.
  const child = spawn(
    "firebase",
    ["emulators:exec", "--only", "firestore,auth", "--project", DEMO_PROJECT, DEV_COMMAND],
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
