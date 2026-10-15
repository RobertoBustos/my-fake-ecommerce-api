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

// Separado de index.js para poder construir la app en tests sin levantar un
// puerto real (supertest pega directo contra el objeto `app`).
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
    // Recomendado por Apollo cuando se integra con un http.Server propio:
    // cierra las conexiones en curso de forma ordenada en vez de cortarlas.
    plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
  });

  await server.start();

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use(
    "/graphql",
    cors(),
    express.json(),
    expressMiddleware(server, { context: createContext })
  );

  return { app, httpServer };
};
