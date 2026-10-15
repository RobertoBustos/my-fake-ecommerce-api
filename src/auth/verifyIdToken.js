import { GraphQLError } from "graphql";
import { getAuth } from "firebase-admin/auth";

const unauthenticated = (message) =>
  new GraphQLError(message, { extensions: { code: "UNAUTHENTICATED" } });

export const verifyIdToken = async (authorizationHeader) => {
  const token = authorizationHeader?.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length)
    : null;
  if (!token) {
    throw unauthenticated("Missing Firebase ID token");
  }
  try {
    return await getAuth().verifyIdToken(token);
  } catch {
    throw unauthenticated("Invalid Firebase ID token");
  }
};
