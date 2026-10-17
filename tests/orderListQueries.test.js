import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";
import { createLoaders } from "../src/dataloaders/index.js";
import db from "../src/config/firestore.js";

// The order lists filter in the Firestore query itself (ECOMAPI-66), so these
// check the filters there: status, owner and direct id.
describe("order list queries filter in Firestore", () => {
  const userA = `list-user-a-${randomUUID()}`;
  const userB = `list-user-b-${randomUUID()}`;
  const cart = `list-cart-${randomUUID()}`;
  const orders = {};

  const seedOrder = async (key, userId, status) => {
    const ref = await db.collection("orders").add({
      userId,
      cart,
      status,
      customer: null,
      address: null,
      paymentId: null,
    });
    orders[key] = ref.id;
  };

  beforeAll(async () => {
    await seedOrder("incomplete", userA, "INCOMPLETE");
    await seedOrder("pending", userA, "PAYMENT_PENDING");
    await seedOrder("complete", userA, "COMPLETE");
    await seedOrder("cancelled", userA, "CANCELLED");
    await seedOrder("otherUser", userB, "INCOMPLETE");
  });

  afterAll(async () => {
    await Promise.all(Object.values(orders).map((id) => db.collection("orders").doc(id).delete()));
  });

  const run = async (uid, query, variables = {}) => {
    const server = new ApolloServer({ typeDefs, resolvers });
    const response = await server.executeOperation(
      { query, variables },
      { contextValue: { user: { uid }, loaders: createLoaders() } }
    );
    return response.body.singleResult;
  };
  const ids = (connection) => connection.edges.map((e) => e.node.id).sort();

  it("incompleteOrders returns only the user's open orders", async () => {
    const { data, errors } = await run(
      userA,
      `query ($cart: String) { incompleteOrders(cart: $cart) { edges { node { id status } } } }`,
      { cart }
    );
    expect(errors).toBeUndefined();
    expect(ids(data.incompleteOrders)).toEqual([orders.incomplete, orders.pending].sort());
  });

  it("orders filters by status and owner", async () => {
    const { data, errors } = await run(
      userA,
      `query ($cart: String) { orders(cart: $cart, status: COMPLETE) { edges { node { id } } } }`,
      { cart }
    );
    expect(errors).toBeUndefined();
    expect(ids(data.orders)).toEqual([orders.complete]);
  });

  it("orders by id still hides another user's order", async () => {
    const { data, errors } = await run(
      userA,
      `query ($id: ID!) { orders(id: $id) { edges { node { id } } } }`,
      { id: orders.otherUser }
    );
    expect(errors).toBeUndefined();
    expect(data.orders.edges).toHaveLength(0);
  });

  it("a cursor from another user's orders is rejected", async () => {
    const { data: page } = await run(
      userB,
      `query ($cart: String) { orders(cart: $cart, first: 1) { pageInfo { endCursor } } }`,
      { cart }
    );
    const { errors } = await run(
      userA,
      `query ($cart: String, $after: String) {
        orders(cart: $cart, after: $after) { edges { node { id } } }
      }`,
      { cart, after: page.orders.pageInfo.endCursor }
    );
    expect(errors[0].extensions).toMatchObject({
      code: "BAD_USER_INPUT",
      invalidArgument: "after",
    });
  });
});
