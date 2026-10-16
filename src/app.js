import http from "http";
import cors from "cors";
import express from "express";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import { createContext } from "./context.js";
import { validationRules } from "./schema/depthLimit.js";
import { formatError } from "./schema/formatError.js";
import resolvers from "./schema/resolvers.js";
import typeDefs from "./schema/typeDefs/index.js";
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
    plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
  });

  await server.start();

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // express.raw (not express.json): Stripe's signature verification needs
  // the exact raw bytes of the body, not the already-parsed object.
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

  return { app, httpServer };
};
