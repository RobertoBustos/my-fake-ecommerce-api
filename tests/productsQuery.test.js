import { describe, it, expect } from "vitest";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";

describe("products query (H9)", () => {
  it("paginates by cursor using explicit arguments (first/after)", async () => {
    const server = new ApolloServer({ typeDefs, resolvers });

    const firstPage = await server.executeOperation({
      query: `query {
        products(first: 1) {
          edges { node { id } cursor }
          pageInfo { hasNextPage endCursor }
        }
      }`,
    });
    const firstBody = firstPage.body.singleResult;
    expect(firstBody.errors).toBeUndefined();
    expect(firstBody.data.products.edges).toHaveLength(1);
    expect(firstBody.data.products.pageInfo.hasNextPage).toBe(true);

    const endCursor = firstBody.data.products.pageInfo.endCursor;
    const secondPage = await server.executeOperation({
      query: `query ($after: String!) {
        products(first: 1, after: $after) {
          edges { node { id } cursor }
        }
      }`,
      variables: { after: endCursor },
    });
    const secondBody = secondPage.body.singleResult;
    expect(secondBody.errors).toBeUndefined();
    expect(secondBody.data.products.edges[0].node.id).not.toBe(
      firstBody.data.products.edges[0].node.id
    );
  });

  it("filters by the explicit category argument", async () => {
    const server = new ApolloServer({ typeDefs, resolvers });

    const response = await server.executeOperation({
      query: `query {
        products(category: "jewelery") {
          edges { node { id category } }
        }
      }`,
    });
    const { data, errors } = response.body.singleResult;
    expect(errors).toBeUndefined();
    expect(data.products.edges.length).toBeGreaterThan(0);
    data.products.edges.forEach(({ node }) => {
      expect(node.category).toBe("jewelery");
    });
  });
});
