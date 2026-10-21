import { requireEnv } from "./env.js";

// Signs in to Firebase Auth with email and password through the Identity
// Toolkit REST API, the same thing the app does, and returns the ID token.
// A token lasts one hour, longer than a run, so each user signs in once.

export type E2EUser = "main" | "other";

const CREDENTIALS: Record<E2EUser, { email: string; password: string }> = {
  main: { email: "E2E_EMAIL", password: "E2E_PASSWORD" },
  other: { email: "E2E_OTHER_EMAIL", password: "E2E_OTHER_PASSWORD" },
};

const SIGN_IN_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";

const tokens = new Map<E2EUser, Promise<string>>();

const signIn = async (user: E2EUser): Promise<string> => {
  const key = requireEnv("E2E_FIREBASE_WEB_API_KEY");
  const email = requireEnv(CREDENTIALS[user].email);
  const password = requireEnv(CREDENTIALS[user].password);
  const response = await fetch(`${SIGN_IN_URL}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = (await response.json()) as { idToken?: string; error?: { message?: string } };
  if (!response.ok || !body.idToken) {
    // Firebase's own code (INVALID_LOGIN_CREDENTIALS, API_KEY_INVALID...),
    // never the request, so no credential ends up in the output.
    throw new Error(`Firebase sign-in failed for ${email}: ${body.error?.message ?? response.status}`);
  }
  return body.idToken;
};

export const getIdToken = (user: E2EUser = "main"): Promise<string> => {
  let token = tokens.get(user);
  if (!token) {
    token = signIn(user);
    // A failed sign-in isn't cached, so the next test tries again.
    token.catch(() => tokens.delete(user));
    tokens.set(user, token);
  }
  return token;
};
