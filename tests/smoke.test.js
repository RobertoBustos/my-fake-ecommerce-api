// Carga .env en local; en CI, STRIPE_SECRET_KEY ya viene como variable de entorno
// y dotenv simplemente no encuentra el archivo, sin fallar.
import "dotenv/config";

import { describe, it, expect } from "vitest";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";

describe("smoke test", () => {
  it("levanta Apollo y responde a { __typename }", async () => {
    const server = new ApolloServer({ typeDefs, resolvers });

    const response = await server.executeOperation({
      query: "{ __typename }",
    });

    expect(response.body.kind).toBe("single");
    expect(response.body.singleResult.errors).toBeUndefined();
    expect(response.body.singleResult.data).toEqual({ __typename: "Query" });
  });
});
