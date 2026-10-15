import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import env from "./config/env.js";
import { createContext } from "./context.js";
import { validationRules } from "./schema/depthLimit.js";
import { formatError } from "./schema/formatError.js";
import resolvers from "./schema/resolvers.js";
import typeDefs from "./schema/typeDefs/index.js";
const PORT = env.PORT;
const HOST = env.HOST;

const server = new ApolloServer({
  typeDefs,
  resolvers,
  status400ForVariableCoercionErrors: true,
  includeStacktraceInErrorResponses: false,
  formatError,
  validationRules,
});

const { url } = await startStandaloneServer(server, {
  listen: { port: PORT, host: HOST },
  context: createContext,
});

console.log(`🚀  Server ready at: ${url}`);
