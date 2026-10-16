import { GraphQLError } from "graphql";
import { getAuth } from "firebase-admin/auth";
import { firebaseApp } from "../config/firestore.js";

// This is thrown while building the context, before the operation runs, and
// Apollo answers those errors with a 500 unless extensions.http says
// otherwise. Apollo strips `http` from the response body.
const unauthenticated = (message) =>
  new GraphQLError(message, {
    extensions: { code: "UNAUTHENTICATED", http: { status: 401 } },
  });

export const verifyIdToken = async (authorizationHeader) => {
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
