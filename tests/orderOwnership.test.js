import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";
import { createLoaders } from "../src/dataloaders/index.js";
import db from "../src/config/firestore.js";
import { createOrder } from "../src/db/orders.js";

describe("Orders isolated per user (H2)", () => {
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

  it("user B doesn't see user A's order", async () => {
    const order = await createOrder({ cartId }, "user-a");
    orderId = order.id;

    const response = await queryOrder("user-b");
    const { data, errors } = response.body.singleResult;

    expect(errors).toBeUndefined();
    expect(data.orders.edges).toHaveLength(0);
  });

  it("user A does see their own order", async () => {
    const response = await queryOrder("user-a");
    const { data, errors } = response.body.singleResult;

    expect(errors).toBeUndefined();
    expect(data.orders.edges).toHaveLength(1);
    expect(data.orders.edges[0].node.id).toBe(orderId);
  });
});
