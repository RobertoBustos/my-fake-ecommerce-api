import { describe, it, expect, vi } from "vitest";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import { formatError } from "../src/schema/formatError.js";

// The products query reads the catalog index.
vi.mock("../src/db/catalogIndex.js", async (importOriginal) => {
  const leak = vi.fn(() => {
    throw new Error("ENOENT: no such file or directory, open '/etc/secret.json'");
  });
  return { ...(await importOriginal()), listCatalogEntries: leak };
});

import resolvers from "../src/schema/resolvers.js";

describe("formatError (H? - domain errors translated at the edge)", () => {
  it("an unexpected error returns INTERNAL_SERVER_ERROR without internal details", async () => {
    const server = new ApolloServer({ typeDefs, resolvers, formatError });

    const response = await server.executeOperation({
      query: `query { products(first: 1) { edges { node { id } } } }`,
    });

    const { errors } = response.body.singleResult;
    expect(errors).toBeDefined();
    expect(errors[0].extensions.code).toBe("INTERNAL_SERVER_ERROR");
    expect(errors[0].message).not.toMatch(/ENOENT|secret\.json/);
  });

  it("lets known domain errors pass through unchanged", async () => {
    // We use createOrder (reads src/db/cart.js, not products.js) to avoid
    // colliding with the products mock that throws an unexpected error above.
    const server = new ApolloServer({ typeDefs, resolvers, formatError });

    const response = await server.executeOperation(
      {
        query: `mutation {
          createOrder(input: { cartId: "cart-that-does-not-exist" }) {
            success
          }
        }`,
      },
      { contextValue: { user: { uid: "test-user" } } }
    );

    const { errors } = response.body.singleResult;
    expect(errors[0].extensions.code).toBe("NOT_FOUND");
    expect(errors[0].message).toBe("Cart not found");
  });
});
