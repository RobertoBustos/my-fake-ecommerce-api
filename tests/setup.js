import { existsSync } from "fs";

// Loads .env for local runs, with Node's own loader: variables already set in
// the environment win over the file, and CI, which has no .env, skips it.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}
