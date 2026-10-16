import http from "http";
import cors from "cors";
import express from "express";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import { createContext } from "./context.js";
import { asyncHandler } from "./middleware/asyncHandler.js";
import { requestId } from "./middleware/requestId.js";
import { validationRules } from "./schema/depthLimit.js";
import { errorLoggingPlugin } from "./schema/errorLogging.js";
import { formatError } from "./schema/formatError.js";
import resolvers from "./schema/resolvers.js";
import typeDefs from "./schema/typeDefs/index.js";
import { logger } from "./utils/logger.js";
import { handleStripeWebhook } from "./webhooks/stripeWebhook.js";

// Separated from index.js so tests can build the app without binding a real
// port (supertest hits the `app` object directly).
export const createApp = async () => {
  const app = express();
  const httpServer = http.createServer(app);

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    status400ForVariableCoercionErrors: true,
    includeStacktraceInErrorResponses: false,
    formatError,
    validationRules,
    // Recommended by Apollo when integrating with a self-managed
    // http.Server: closes in-flight connections gracefully instead of
    // dropping them.
    plugins: [ApolloServerPluginDrainHttpServer({ httpServer }), errorLoggingPlugin],
  });

  await server.start();

  // First, so every route (and every log line it writes) has a request ID.
  app.use(requestId);

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // express.raw (not express.json): Stripe's signature verification needs
  // the exact raw bytes of the body, not the already-parsed object.
  app.post(
    "/webhooks/stripe",
    express.raw({ type: "application/json" }),
    asyncHandler(handleStripeWebhook)
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

  return { app, httpServer };
};
