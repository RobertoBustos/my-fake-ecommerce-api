import { describe, it, expect } from "vitest";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";

describe("updateOrder no acepta status del cliente (H3)", () => {
  it("una mutation con status es rechazada por el esquema", async () => {
    const server = new ApolloServer({ typeDefs, resolvers });

    const response = await server.executeOperation({
      query: `mutation {
        updateOrder(input: { id: "some-id", status: COMPLETE }) {
          success
        }
      }`,
    });

    const { errors } = response.body.singleResult;
    expect(errors).toBeDefined();
    expect(errors[0].extensions.code).toBe("GRAPHQL_VALIDATION_FAILED");
  });
});
