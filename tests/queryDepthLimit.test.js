import { describe, it, expect } from "vitest";
import { buildSchema, parse, validate } from "graphql";
import { ApolloServer } from "@apollo/server";
import { validationRules, MAX_QUERY_DEPTH } from "../src/schema/depthLimit.js";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";

// Esquema sintético solo para probar la regla de profundidad de forma
// determinista: el schema real de la API no tiene un único árbol de
// objetos con 8 niveles reales de anidamiento.
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

describe("Límite de profundidad de queries", () => {
  it(`rechaza una query de profundidad ${MAX_QUERY_DEPTH + 1}`, () => {
    const errors = validate(
      testSchema,
      parse(deepQuery(MAX_QUERY_DEPTH + 1)),
      validationRules
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/exceeds maximum operation depth/i);
  });

  it(`acepta una query de profundidad ${MAX_QUERY_DEPTH} (el límite)`, () => {
    const errors = validate(
      testSchema,
      parse(deepQuery(MAX_QUERY_DEPTH)),
      validationRules
    );
    expect(errors).toHaveLength(0);
  });

  it("el server real sigue aceptando queries normales con la regla activa", async () => {
    const server = new ApolloServer({ typeDefs, resolvers, validationRules });
    const response = await server.executeOperation({
      query: `{ __typename }`,
    });
    const { errors } = response.body.singleResult;
    expect(errors).toBeUndefined();
  });
});
