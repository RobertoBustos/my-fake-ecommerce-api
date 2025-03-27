import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import resolvers from "./schema/resolvers.js";
import typeDefs from "./schema/typeDefs/index.js";
const PORT = 5252;
const HOST = "192.168.100.35";

const server = new ApolloServer({
  typeDefs,
  resolvers,
  status400ForVariableCoercionErrors: true,
  includeStacktraceInErrorResponses: false,
  formatError: (formattedError, error) => {
    return formattedError;
  },
});

const { url } = await startStandaloneServer(server, {
  listen: { port: PORT, host: HOST },
  context: async ({ req, res }) => ({
    headers: req.headers,
  }),
});

console.log(`🚀  Server ready at: ${url}`);
