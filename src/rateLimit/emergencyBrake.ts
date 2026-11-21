import { HeaderMap } from "@apollo/server";
import { GraphQLError } from "graphql";

// The emergency brake: operations or users switched off by an environment
// variable, for when a client is stuck in a loop and the rate limiter isn't
// enough (or is the thing that failed). Setting the variable with
// `gcloud run services update --update-env-vars` makes a new revision in
// about a minute, without a build or a PR. Read once at startup, so it costs
// nothing per request and never reads Firestore.
//
// BLOCKED_OPERATIONS: comma-separated root fields (registerPushToken) or
//   operation names (Register); a match answers SERVICE_UNAVAILABLE.
// BLOCKED_UIDS: comma-separated uids; their requests answer FORBIDDEN.

const listOf = (value: string | undefined) =>
  new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );

// Answered with HTTP 200, like any other GraphQL error from a resolver: a
// brake put on purpose shouldn't count as 5xx against the availability SLO
// or fire the 5xx alert.
const rejection = (message: string, code: "SERVICE_UNAVAILABLE" | "FORBIDDEN") =>
  new GraphQLError(message, {
    extensions: {
      code,
      ...(code === "SERVICE_UNAVAILABLE" && { retryable: false }),
      http: { status: code === "FORBIDDEN" ? 403 : 200, headers: new HeaderMap() },
    },
  });

export class EmergencyBrake {
  readonly blockedOperations: ReadonlySet<string>;
  readonly blockedUids: ReadonlySet<string>;

  constructor({ blockedOperations = "", blockedUids = "" }: { blockedOperations?: string; blockedUids?: string } = {}) {
    this.blockedOperations = listOf(blockedOperations);
    this.blockedUids = listOf(blockedUids);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env) {
    return new EmergencyBrake({ blockedOperations: env.BLOCKED_OPERATIONS, blockedUids: env.BLOCKED_UIDS });
  }

  get engaged() {
    return this.blockedOperations.size > 0 || this.blockedUids.size > 0;
  }

  // The error to answer with, or undefined to let the request through.
  check({ uid, operationName, rootFields }: { uid: string; operationName?: string | null; rootFields: Iterable<string> }) {
    if (this.blockedUids.has(uid)) return rejection("This user is blocked", "FORBIDDEN");
    const blocked =
      (operationName && this.blockedOperations.has(operationName)) ||
      [...rootFields].some((field) => this.blockedOperations.has(field));
    return blocked ? rejection("This operation is switched off for now", "SERVICE_UNAVAILABLE") : undefined;
  }
}
