import { describe, it, expect, vi } from "vitest";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import { formatError } from "../src/schema/formatError.js";

vi.mock("../src/db/products.js", () => ({
  getProducts: vi.fn(() => {
    throw new Error(
      "ENOENT: no such file or directory, open '/etc/secret.json'"
    );
  }),
}));

import resolvers from "../src/schema/resolvers.js";

describe("formatError (H? - errores de dominio traducidos en el borde)", () => {
  it("un error inesperado regresa INTERNAL_SERVER_ERROR sin detalles internos", async () => {
    const server = new ApolloServer({ typeDefs, resolvers, formatError });

    const response = await server.executeOperation({
      query: `query { products(first: 1) { edges { node { id } } } }`,
    });

    const { errors } = response.body.singleResult;
    expect(errors).toBeDefined();
    expect(errors[0].extensions.code).toBe("INTERNAL_SERVER_ERROR");
    expect(errors[0].message).not.toMatch(/ENOENT|secret\.json/);
  });

  it("deja pasar sin cambios los errores de dominio conocidos", async () => {
    // Usamos createOrder (lee src/db/cart.js, no products.js) para no chocar
    // con el mock de getProducts que lanza un error inesperado arriba.
    const server = new ApolloServer({ typeDefs, resolvers, formatError });

    const response = await server.executeOperation({
      query: `mutation {
        createOrder(input: { cartId: "cart-that-does-not-exist" }) {
          success
        }
      }`,
    });

    const { errors } = response.body.singleResult;
    expect(errors[0].extensions.code).toBe("NOT_FOUND");
    expect(errors[0].message).toBe("Cart not found");
  });
});
