import http from "http";
import cors from "cors";
import express from "express";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import { createContext } from "./context.js";
import { requestId } from "./middleware/requestId.js";
import { validationRules } from "./schema/depthLimit.js";
import { errorLoggingPlugin } from "./schema/errorLogging.js";
import { formatError } from "./schema/formatError.js";
import resolvers from "./schema/resolvers.js";
import typeDefs from "./schema/typeDefs/index.js";
import { logger } from "./utils/logger.js";
import { SHUTDOWN_GRACE_PERIOD_MS } from "./shutdown.js";
import { handleStripeWebhook } from "./webhooks/stripeWebhook.js";

// Separated from index.js so tests can build the app without binding a real
// port (supertest hits the `app` object directly).
export const createApp = async () => {
  const app = express();
  const httpServer = http.createServer(app);

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    includeStacktraceInErrorResponses: false,
    formatError,
    validationRules,
    // Apollo's own default, made explicit: the depth limit doesn't count
    // __schema, so introspection must be off in production (the Dockerfile
    // sets NODE_ENV=production). Local runs and tests keep it on.
    introspection: process.env.NODE_ENV !== "production",
    // With introspection off, validation errors would still leak the schema
    // through "Did you mean ...?" suggestions.
    hideSchemaDetailsFromClientErrors: process.env.NODE_ENV === "production",
    // Recommended by Apollo when integrating with a self-managed
    // http.Server: on server.stop() (see shutdown.js), lets in-flight
    // requests finish instead of dropping them.
    plugins: [
      ApolloServerPluginDrainHttpServer({
        httpServer,
        stopGracePeriodMillis: SHUTDOWN_GRACE_PERIOD_MS,
      }),
      errorLoggingPlugin,
    ],
  });

  await server.start();

  // First, so every route (and every log line it writes) has a request ID.
  app.use(requestId);

  // Not /healthz: Cloud Run reserves some paths ending in "z" and answers them
  // with its own 404 before they reach the container.
  app.get("/healthcheck", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // express.raw (not express.json): Stripe's signature verification needs
  // the exact raw bytes of the body, not the already-parsed object. Express 5
  // forwards a rejected promise from the async handler to the error handler
  // below, so a Firestore failure answers 500 and Stripe retries (H15).
  app.post(
    "/webhooks/stripe",
    express.raw({ type: "application/json" }),
    handleStripeWebhook
  );

  app.use(
    "/graphql",
    cors(),
    express.json(),
    expressMiddleware(server, { context: createContext })
  );

  // Errors that reach Express outside of Apollo (e.g. a malformed JSON body
  // is a 400, which Express already reports well). Only 5xx are unexpected.
  // Express treats a middleware as an error handler only if it takes 4 args.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) {
      logger.error(err.message, { stack: err.stack });
    }
    res.status(status).json({
      error: status >= 500 ? "Internal Server Error" : err.message,
    });
  });

  return { app, httpServer, server };
};
