import { createHash } from "crypto";
import { HeaderMap, type ApolloServerPlugin, type GraphQLRequestContext } from "@apollo/server";
import { GraphQLError, type FormattedExecutionResult } from "graphql";
import type { Context } from "#src/context";
import { rootFieldsOf } from "#src/observability/operationSummary";
import { logger } from "#src/utils/logger";
import { MAX_TRACKED_KEYS, OPERATION_CLASSES, REPLAY_MS, type OperationClassName } from "./limits.ts";
import { EmergencyBrake } from "./emergencyBrake.ts";
import { BoundedMap, RateLimiter } from "./limiter.ts";

// How long a repeated request waits for the identical one already running
// before it gives up and runs on its own.
const SINGLE_FLIGHT_TIMEOUT_MS = 30 * 1000;

const CLASS_BY_FIELD = new Map<string, OperationClassName>(
  Object.entries(OPERATION_CLASSES).flatMap(([name, operationClass]) =>
    ("fields" in operationClass ? operationClass.fields : []).map((field) => [field, name as OperationClassName])
  )
);

// The class a request is charged to: the most restrictive among its root
// fields. Idempotent only if every root field is.
const classify = (requestContext: GraphQLRequestContext<Context>, rootFields: Set<string>) => {
  if (requestContext.operation?.operation !== "mutation") {
    return { operationClass: "query" as const, idempotent: false };
  }
  const classes = [...rootFields].map(
    (field) => CLASS_BY_FIELD.get(field) ?? "mutation"
  );
  const operationClass = classes.reduce<OperationClassName>(
    (strictest, name) => (OPERATION_CLASSES[name].perMinute < OPERATION_CLASSES[strictest].perMinute ? name : strictest),
    "mutation"
  );
  const idempotent = classes.length > 0 && classes.every((name) => "idempotent" in OPERATION_CLASSES[name]);
  return { operationClass, idempotent };
};

// Identical requests: same user, same document, same variables.
const requestKey = (requestContext: GraphQLRequestContext<Context>) =>
  createHash("sha256")
    .update(requestContext.contextValue.user.uid)
    .update("\0")
    .update(requestContext.queryHash ?? "")
    .update("\0")
    .update(requestContext.operationName ?? "")
    .update("\0")
    .update(JSON.stringify(requestContext.request.variables ?? {}))
    .digest("hex");

// Logs keep only part of who was limited: 8 characters of the uid, and the
// IP without its last octet (IPv4) or past its first three groups (IPv6).
const ipPrefix = (ip: string) =>
  ip.includes(":") && !ip.startsWith("::ffff:")
    ? `${ip.split(":").slice(0, 3).join(":")}::`
    : ip.replace(/\.\d+$/, ".x");

const rateLimited = (retryAfterSeconds: number) =>
  new GraphQLError(`Too many requests, try again in ${retryAfterSeconds} s`, {
    extensions: {
      code: "RATE_LIMITED",
      retryAfter: retryAfterSeconds,
      // Apollo strips `http` from the response body.
      http: { status: 429, headers: new HeaderMap([["retry-after", String(retryAfterSeconds)]]) },
    },
  });

const replayOf = (result: FormattedExecutionResult) => ({
  http: { status: undefined, headers: new HeaderMap() },
  body: { kind: "single" as const, singleResult: result },
});

// Stops repeated requests before they reach a resolver, so before any
// Firestore read or write: a client stuck in a loop (H42) gets RATE_LIMITED
// with a Retry-After, answered from memory. Identical requests in flight
// share one execution, and an idempotent one repeated within REPLAY_MS is
// answered with the previous result. Only /graphql goes through Apollo: the
// Stripe webhook and /healthcheck aren't limited.
// The emergency brake (emergencyBrake.ts) goes first, so a blocked request
// isn't charged to any budget nor answered from a replay.
export const rateLimitPlugin = ({
  limiter = new RateLimiter(),
  brake = EmergencyBrake.fromEnv(),
  now = Date.now,
} = {}): ApolloServerPlugin<Context> => {
  const inFlight = new Map<string, Promise<FormattedExecutionResult>>();
  const replays = new BoundedMap<string, { result: FormattedExecutionResult; until: number }>(MAX_TRACKED_KEYS);

  return {
    async serverWillStart() {
      if (brake.engaged) {
        // Operation names aren't personal; uids are, so only their count.
        logger.warn("Emergency brake engaged", {
          blockedOperations: [...brake.blockedOperations],
          blockedUids: brake.blockedUids.size,
        });
      }
    },

    async requestDidStart() {
      let key: string | undefined;
      let idempotent = false;
      let settle: ((result: FormattedExecutionResult) => void) | undefined;

      return {
        async didResolveOperation(requestContext) {
          const { uid } = requestContext.contextValue.user;
          const { operation, document } = requestContext;
          const rootFields = operation && document ? rootFieldsOf(operation.selectionSet, document) : new Set<string>();
          const braked = brake.check({ uid, operationName: requestContext.operationName, rootFields });
          if (braked) throw braked;
          const classified = classify(requestContext, rootFields);
          idempotent = classified.idempotent;
          const decision = limiter.check({
            uid,
            ip: requestContext.contextValue.clientIp,
            operationClass: classified.operationClass,
          });
          if (decision.allowed) return;
          if (decision.quarantined) {
            const { scope, id } = decision.quarantined;
            logger.warn("Rate limit quarantine started", {
              scope,
              ...(scope === "user" ? { uid: id.slice(0, 8) } : { ipPrefix: ipPrefix(id) }),
              operationClass: classified.operationClass,
              operationName: requestContext.operationName ?? "anonymous",
              seconds: decision.retryAfterSeconds,
            });
          }
          throw rateLimited(decision.retryAfterSeconds);
        },

        async responseForOperation(requestContext) {
          key = requestKey(requestContext);
          const replay = replays.get(key);
          if (replay && replay.until > now()) return replayOf(replay.result);
          const running = inFlight.get(key);
          if (running) {
            let timer: NodeJS.Timeout | undefined;
            const result = await Promise.race([
              running,
              new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), SINGLE_FLIGHT_TIMEOUT_MS))),
            ]);
            clearTimeout(timer);
            return result ? replayOf(result) : null;
          }
          inFlight.set(key, new Promise((resolve) => (settle = resolve)));
          return null;
        },

        async willSendResponse(requestContext) {
          if (!settle || !key) return;
          const body = requestContext.response.body;
          const result: FormattedExecutionResult =
            body.kind === "single" ? body.singleResult : { errors: body.initialResult.errors };
          inFlight.delete(key);
          settle(result);
          if (idempotent && !result.errors?.length) {
            replays.set(key, { result, until: now() + REPLAY_MS });
          }
        },
      };
    },
  };
};
