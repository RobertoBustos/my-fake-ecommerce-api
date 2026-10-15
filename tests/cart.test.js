import { describe, it, expect } from "vitest";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";

describe("addToCart mutation (H5)", () => {
  it("regresa BAD_USER_INPUT si la cantidad excede purchaseLimits", async () => {
    const server = new ApolloServer({ typeDefs, resolvers });

    const response = await server.executeOperation({
      query: `mutation {
        addToCart(input: { productId: "1", quantity: 11, cartId: "cart-h5-test" }) {
          success
        }
      }`,
    });

    expect(response.body.kind).toBe("single");
    const { errors } = response.body.singleResult;
    expect(errors).toBeDefined();
    expect(errors[0].extensions.code).toBe("BAD_USER_INPUT");
  });
});
