import { fileURLToPath } from "url";

// Gets a Firebase ID token from the local Auth emulator, for calling the API
// by hand during development. It only ever talks to the emulator: the demo
// project can't verify real tokens, and the emulator never needs a real key.
const DEFAULT_EMULATOR_HOST = "127.0.0.1:9099";
const DEFAULT_EMAIL = "dev@example.com";
const DEFAULT_PASSWORD = "local-dev-password";

interface EmulatorResponse {
  idToken?: string;
  localId?: string;
  error?: { message?: string };
}

const callEmulator = async (
  host: string,
  action: "signUp" | "signInWithPassword",
  body: { email: string; password: string }
) => {
  const url = `http://${host}/identitytoolkit.googleapis.com/v1/accounts:${action}?key=emulator`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, returnSecureToken: true }),
  });
  const data = (await response.json()) as EmulatorResponse;
  return { ok: response.ok, data };
};

// Signs up the user the first time and signs in after that, so running it
// again (or after restarting the emulator) always works.
export const getLocalIdToken = async ({
  host = process.env.FIREBASE_AUTH_EMULATOR_HOST || DEFAULT_EMULATOR_HOST,
  email = DEFAULT_EMAIL,
  password = DEFAULT_PASSWORD,
}: { host?: string; email?: string; password?: string } = {}) => {
  let result: Awaited<ReturnType<typeof callEmulator>>;
  try {
    result = await callEmulator(host, "signUp", { email, password });
    if (!result.ok && result.data.error?.message === "EMAIL_EXISTS") {
      result = await callEmulator(host, "signInWithPassword", { email, password });
    }
  } catch (err) {
    throw new Error(
      `Couldn't reach the Auth emulator at ${host}. Start it with ` +
        "`npx firebase emulators:start --only firestore,auth --project demo-ecommerce-api`.",
      { cause: err }
    );
  }
  if (!result.ok) {
    throw new Error(`Auth emulator error: ${result.data.error?.message ?? "unknown"}`);
  }
  return { idToken: result.data.idToken, uid: result.data.localId };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const email = process.argv[2];
  const { idToken } = await getLocalIdToken(email ? { email } : {});
  console.log(idToken);
}
