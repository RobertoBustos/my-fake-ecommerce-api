import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { getLocalIdToken } from "../scripts/localToken.js";
import { verifyIdToken } from "../src/auth/verifyIdToken.js";

// npm run test:emulator starts the Auth emulator and sets
// FIREBASE_AUTH_EMULATOR_HOST, so this goes through the real firebase-admin
// verification, not a mock.
describe("Local ID token from the Auth emulator", () => {
  it("gives a token the API's verifyIdToken accepts", async () => {
    const email = `dev-${randomUUID()}@example.com`;

    const { idToken, uid } = await getLocalIdToken({ email });
    const user = await verifyIdToken(`Bearer ${idToken}`);

    expect(user.uid).toBe(uid);
    expect(user.email).toBe(email);
  });

  it("signs in again instead of failing when the user already exists", async () => {
    const email = `dev-${randomUUID()}@example.com`;

    const first = await getLocalIdToken({ email });
    const second = await getLocalIdToken({ email });

    expect(second.uid).toBe(first.uid);
  });
});
