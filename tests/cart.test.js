import { describe, it, expect } from "vitest";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";
import { createLoaders } from "../src/dataloaders/index.js";

describe("addToCart mutation (H5)", () => {
  it("returns BAD_USER_INPUT when quantity exceeds purchaseLimits", async () => {
    const server = new ApolloServer({ typeDefs, resolvers });

    const response = await server.executeOperation({
      query: `mutation {
        addToCart(input: { productId: "1", quantity: 11, cartId: "cart-h5-test" }) {
          success
        }
      }`,
    }, { contextValue: { user: { uid: "user-h5" }, loaders: createLoaders() } });

    expect(response.body.kind).toBe("single");
    const { errors } = response.body.singleResult;
    expect(errors).toBeDefined();
    expect(errors[0].extensions.code).toBe("BAD_USER_INPUT");
  });
});
