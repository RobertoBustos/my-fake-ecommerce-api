import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";
import { createLoaders } from "../src/dataloaders/index.js";
import db from "../src/config/firestore.js";
import { createOrder } from "../src/db/orders.js";

describe("Órdenes aisladas por usuario (H2)", () => {
  const cartId = `cart-ownership-${randomUUID()}`;
  let orderId;

  afterAll(async () => {
    if (orderId) {
      await db.collection("orders").doc(orderId).delete();
    }
  });

  const queryOrder = async (uid) => {
    const server = new ApolloServer({ typeDefs, resolvers });
    return server.executeOperation(
      {
        query: `query ($id: ID!) {
          orders(id: $id) { edges { node { id } } }
        }`,
        variables: { id: orderId },
      },
      { contextValue: { user: { uid }, loaders: createLoaders() } }
    );
  };

  it("el usuario B no ve la orden del usuario A", async () => {
    const order = await createOrder({ cartId }, "user-a");
    orderId = order.id;

    const response = await queryOrder("user-b");
    const { data, errors } = response.body.singleResult;

    expect(errors).toBeUndefined();
    expect(data.orders.edges).toHaveLength(0);
  });

  it("el usuario A sí ve su propia orden", async () => {
    const response = await queryOrder("user-a");
    const { data, errors } = response.body.singleResult;

    expect(errors).toBeUndefined();
    expect(data.orders.edges).toHaveLength(1);
    expect(data.orders.edges[0].node.id).toBe(orderId);
  });
});
