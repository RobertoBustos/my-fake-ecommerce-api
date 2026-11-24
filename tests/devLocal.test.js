import { describe, it, expect } from "vitest";
import { devLocalEnv, DEMO_PROJECT, emulatorsFor, parseDevLocalArgs } from "../scripts/devLocal.js";

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

// --auth-project: a phone with the real app signs in with the app's Firebase
// project, so the API verifies that project's tokens; everything else stays
// local.
describe("dev:local --auth-project", () => {
  const options = { authProject: "my-app-project" };
  const fileWithEmulatorAuth = { FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099", FIRESTORE_PROJECT_ID: "demo-ecommerce-api" };

  it("verifies the project's tokens but keeps Firestore on the emulator", () => {
    const env = devLocalEnv({}, fileWithEmulatorAuth, options);

    expect(env.FIRESTORE_PROJECT_ID).toBe("my-app-project");
    expect(env.FIRESTORE_EMULATOR_HOST).toBe("127.0.0.1:8080");
    expect(env.SEARCH_ENGINE).toBe("memory");
  });

  it("blanks the Auth emulator host instead of removing it, so .env can't set it back", () => {
    const env = devLocalEnv({ FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" }, fileWithEmulatorAuth, options);

    expect(env).toHaveProperty("FIREBASE_AUTH_EMULATOR_HOST", "");
  });

  it("listens on the network by default, unless HOST says otherwise", () => {
    expect(devLocalEnv({}, {}, options).HOST).toBe("0.0.0.0");
    expect(devLocalEnv({}, { HOST: "localhost" }, options).HOST).toBe("localhost");
  });

  it("still refuses a live Stripe key", () => {
    expect(() => devLocalEnv({}, { STRIPE_SECRET_KEY: "sk_live_abc" }, options)).toThrow(/live key/);
  });

  it("starts only the Firestore emulator, so emulators:exec doesn't set the Auth emulator host again", () => {
    expect(emulatorsFor(options)).toBe("firestore");
    expect(emulatorsFor({})).toBe("firestore,auth");
  });

  it("reads the option from the command line", () => {
    expect(parseDevLocalArgs([])).toEqual({});
    expect(parseDevLocalArgs(["--auth-project", "my-app-project"])).toEqual(options);
    expect(parseDevLocalArgs(["--auth-project=my-app-project"])).toEqual(options);
  });

  it.each([
    [["--auth-project", "My Project"], /needs a Firebase project id/],
    [["--auth-project", "demo-ecommerce-api"], /demo projects already use the Auth emulator/],
    [["--project", "x"], /Unknown option/],
  ])("rejects %j", (args, message) => {
    expect(() => parseDevLocalArgs(args)).toThrow(message);
  });
});
