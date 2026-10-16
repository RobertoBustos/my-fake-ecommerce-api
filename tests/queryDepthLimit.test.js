import { describe, it, expect } from "vitest";
import { buildSchema, parse, validate } from "graphql";
import { ApolloServer } from "@apollo/server";
import { validationRules, MAX_QUERY_DEPTH } from "../src/schema/depthLimit.js";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";

// Synthetic schema used only to test the depth rule deterministically:
// the API's real schema doesn't have a single object tree with 8 real
// levels of nesting.
const testSchema = buildSchema(`
  type L8 { value: String }
  type L7 { value: String, next: L8 }
  type L6 { value: String, next: L7 }
  type L5 { value: String, next: L6 }
  type L4 { value: String, next: L5 }
  type L3 { value: String, next: L4 }
  type L2 { value: String, next: L3 }
  type L1 { value: String, next: L2 }
  type Query { root: L1 }
`);

const deepQuery = (depth) => {
  let body = "value";
  for (let i = 1; i < depth; i++) {
    body = `next { ${body} }`;
  }
  return `query { root { ${body} } }`;
};

describe("Query depth limit", () => {
  it(`rejects a query of depth ${MAX_QUERY_DEPTH + 1}`, () => {
    const errors = validate(
      testSchema,
      parse(deepQuery(MAX_QUERY_DEPTH + 1)),
      validationRules
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/exceeds maximum operation depth/i);
  });

  it(`accepts a query of depth ${MAX_QUERY_DEPTH} (the limit)`, () => {
    const errors = validate(
      testSchema,
      parse(deepQuery(MAX_QUERY_DEPTH)),
      validationRules
    );
    expect(errors).toHaveLength(0);
  });

  it("the real server still accepts normal queries with the rule active", async () => {
    const server = new ApolloServer({ typeDefs, resolvers, validationRules });
    const response = await server.executeOperation({
      query: `{ __typename }`,
    });
    const { errors } = response.body.singleResult;
    expect(errors).toBeUndefined();
  });
});
