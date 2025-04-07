import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import env from "./config/env.js";
import resolvers from "./schema/resolvers.js";
import typeDefs from "./schema/typeDefs/index.js";
const PORT = env.PORT;
const HOST = env.HOST;

const server = new ApolloServer({
  typeDefs,
  resolvers,
  status400ForVariableCoercionErrors: true,
  includeStacktraceInErrorResponses: false,
  formatError: (formattedError, error) => {
    // here we can catch errors and do stuff with them like send analytics or send email
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
