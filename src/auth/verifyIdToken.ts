import { GraphQLError } from "graphql";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { firebaseApp } from "#src/config/firestore";

// This is thrown while building the context, before the operation runs, and
// Apollo answers those errors with a 500 unless extensions.http says
// otherwise. Apollo strips `http` from the response body.
const unauthenticated = (message: string) =>
  new GraphQLError(message, {
    extensions: { code: "UNAUTHENTICATED", http: { status: 401 } },
  });

export const verifyIdToken = async (
  authorizationHeader: string | undefined
): Promise<DecodedIdToken> => {
  const token = authorizationHeader?.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length)
    : null;
  if (!token) {
    throw unauthenticated("Missing Firebase ID token");
  }
  try {
    return await getAuth(firebaseApp).verifyIdToken(token);
  } catch {
    throw unauthenticated("Invalid Firebase ID token");
  }
};

// What verifyIdToken(token, true) throws when the token itself is the
// problem: malformed, badly signed or expired, revoked, or its user deleted
// or disabled.
const TOKEN_ERROR_CODES = new Set([
  "auth/argument-error",
  "auth/id-token-expired",
  "auth/id-token-revoked",
  "auth/user-not-found",
  "auth/user-disabled",
]);

// The anonymous user's token that mergeAnonymousCart receives as an argument;
// the request's own token is the account's. Its errors carry no http status:
// the caller's session is fine, so the app mustn't read them as a 401.
// checkRevoked also looks the user up, so a deleted user's token, which
// verifyIdToken alone accepts until it expires, is refused here. That lookup
// needs a Firebase Auth role: any other failure (permissions, network,
// Google's public keys) isn't the client's fault, so it surfaces as an
// internal error, logged with its code, instead of an invalid token.
export const verifyAnonymousIdToken = async (token: string): Promise<DecodedIdToken> => {
  let decoded: DecodedIdToken;
  try {
    decoded = await getAuth(firebaseApp).verifyIdToken(token, true);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && TOKEN_ERROR_CODES.has(code)) {
      throw new GraphQLError("Invalid anonymous ID token", {
        extensions: { code: "UNAUTHENTICATED", invalidArgument: "anonymousIdToken" },
      });
    }
    throw new Error(`The anonymous ID token couldn't be verified (${String(code ?? "no code")})`, {
      cause: err,
    });
  }
  if (decoded.firebase.sign_in_provider !== "anonymous") {
    throw new GraphQLError("The token doesn't belong to an anonymous user", {
      extensions: { code: "BAD_USER_INPUT", invalidArgument: "anonymousIdToken" },
    });
  }
  return decoded;
};
