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

// The anonymous user's token that mergeAnonymousCart receives as an argument;
// the request's own token is the account's. Its errors carry no http status:
// the caller's session is fine, so the app mustn't read them as a 401.
// checkRevoked also looks the user up, so a deleted user's token, which
// verifyIdToken alone accepts until it expires, is refused here.
export const verifyAnonymousIdToken = async (token: string): Promise<DecodedIdToken> => {
  let decoded: DecodedIdToken;
  try {
    decoded = await getAuth(firebaseApp).verifyIdToken(token, true);
  } catch {
    throw new GraphQLError("Invalid anonymous ID token", {
      extensions: { code: "UNAUTHENTICATED", invalidArgument: "anonymousIdToken" },
    });
  }
  if (decoded.firebase.sign_in_provider !== "anonymous") {
    throw new GraphQLError("The token doesn't belong to an anonymous user", {
      extensions: { code: "BAD_USER_INPUT", invalidArgument: "anonymousIdToken" },
    });
  }
  return decoded;
};
