import { describe, it, expect } from "vitest";
import { devLocalEnv, DEMO_PROJECT } from "../scripts/devLocal.js";

// npm run dev:local must never reach a real project, whatever .env says:
// these values go into the environment, and an environment variable beats
// the same one in --env-file.
describe("dev:local environment", () => {
  const productionLikeFile = {
    FIRESTORE_PROJECT_ID: "my-real-project",
    SEARCH_ENGINE: "algolia",
    STRIPE_SECRET_KEY: "sk_test_123",
  };

  it("points firebase-admin at the emulators and the demo project, even if .env points elsewhere", () => {
    const env = devLocalEnv({ GCLOUD_PROJECT: "my-real-project" }, productionLikeFile);

    expect(env.FIRESTORE_PROJECT_ID).toBe(DEMO_PROJECT);
    expect(env.GCLOUD_PROJECT).toBe(DEMO_PROJECT);
    expect(env.FIRESTORE_EMULATOR_HOST).toBe("127.0.0.1:8080");
    expect(env.FIREBASE_AUTH_EMULATOR_HOST).toBe("127.0.0.1:9099");
  });

  it("uses the in-memory search index instead of a hosted one", () => {
    expect(devLocalEnv({}, productionLikeFile).SEARCH_ENGINE).toBe("memory");
  });

  it("serves on localhost:4000 by default, not the image's 0.0.0.0:8080 where Firestore listens", () => {
    const env = devLocalEnv({});

    expect(env.HOST).toBe("localhost");
    expect(env.PORT).toBe("4000");
  });

  it("keeps HOST and PORT from the shell first, then from .env", () => {
    expect(devLocalEnv({}, { HOST: "0.0.0.0", PORT: "5252" })).toMatchObject({ HOST: "0.0.0.0", PORT: "5252" });
    expect(devLocalEnv({ PORT: "4100" }, { PORT: "5252" }).PORT).toBe("4100");
  });

  it.each(["sk_live_abc", "rk_live_abc"])("refuses a live Stripe key (%s)", (key) => {
    expect(() => devLocalEnv({}, { STRIPE_SECRET_KEY: key })).toThrow(/live key/);
    expect(() => devLocalEnv({ STRIPE_SECRET_KEY: key })).toThrow(/live key/);
  });
});
