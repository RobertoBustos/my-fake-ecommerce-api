import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The suite reads its settings from the environment. Locally they live in
// .env.e2e at the repo root (ignored by git); in GitHub Actions they come
// from the repository's variables and secrets. A variable already set in the
// environment wins over the file.
const ENV_FILE = fileURLToPath(new URL("../../.env.e2e", import.meta.url));

let loaded = false;
const loadEnvFile = () => {
  if (loaded) return;
  loaded = true;
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
};

export const optionalEnv = (name: string): string | undefined => {
  loadEnvFile();
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

export const requireEnv = (name: string): string => {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(`${name} is not set: add it to .env.e2e (see .env.e2e.example) or to the environment`);
  }
  return value;
};

// Without a trailing slash, so paths can be appended as they are.
export const baseUrl = () => requireEnv("E2E_BASE_URL").replace(/\/+$/, "");
