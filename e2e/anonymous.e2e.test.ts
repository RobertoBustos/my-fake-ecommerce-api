import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAnonymousUser, deleteUser } from "./helpers/auth.js";
import { requireEnv } from "./helpers/env.js";
import { dataOf, errorCodeOf, gql } from "./helpers/graphql.js";
import { ADD_TO_CART, CANCEL_ORDER, CREATE_ORDER, newCartId, ORDER, type OrderNode } from "./helpers/orders.js";

// The mobile app signs in as an anonymous Firebase user, and the API accepts
// that token only because verifyIdToken doesn't look at the provider. Without
// this, requiring an email in the token would break the app and no check
// would fail. Nothing here is charged; the order ends up cancelled, so the
// e2e product gets its unit back, and the anonymous user is deleted.

const PRODUCT = `query Product($id: ID) {
  products(id: $id) { edges { node { id } } }
}`;
const CART = `query Cart($cartId: String) {
  carts(cartId: $cartId) { edges { node { id } } }
}`;

describe("anonymous user against the deployed API", () => {
  const productId = requireEnv("E2E_PRODUCT_ID");
  const cartId = newCartId();
  let idToken: string | undefined;
  let orderId: string | undefined;

  const asAnonymous = () => ({ authorization: `Bearer ${idToken}` });

  const getOrder = async () => {
    const { orders } = dataOf(await gql<{ orders: { edges: { node: OrderNode }[] } }>(ORDER, { id: orderId }, asAnonymous()));
    return orders.edges[0]?.node;
  };

  beforeAll(async () => {
    idToken = await createAnonymousUser();
  });

  // Runs even if a test failed, so a run never leaves units held or the user
  // behind.
  afterAll(async () => {
    if (!idToken) return;
    try {
      if (orderId && (await getOrder())?.status !== "CANCELLED") {
        await gql(CANCEL_ORDER, { input: { id: orderId } }, asAnonymous());
      }
    } finally {
      await deleteUser(idToken);
    }
  });

  it("reads the catalog", async () => {
    const { products } = dataOf(await gql<{ products: { edges: unknown[] } }>(PRODUCT, { id: productId }, asAnonymous()));
    expect(products.edges).toHaveLength(1);
  });

  it("adds to its cart and creates an order", async () => {
    dataOf(await gql(ADD_TO_CART, { input: { cartId, productId, quantity: 1 } }, asAnonymous()));
    const { createOrder } = dataOf(
      await gql<{ createOrder: { data: { id: string; status: string } } }>(CREATE_ORDER, { input: { cartId } }, asAnonymous())
    );
    orderId = createOrder.data.id;
    expect(createOrder.data.status).toBe("INCOMPLETE");
  });

  it("hides its cart and order from another user", async () => {
    expect(orderId).toBeDefined();
    const cart = dataOf(await gql<{ carts: { edges: unknown[] } }>(CART, { cartId }, { as: "other" }));
    expect(cart.carts.edges).toEqual([]);
    const order = dataOf(await gql<{ orders: { edges: unknown[] } }>(ORDER, { id: orderId }, { as: "other" }));
    expect(order.orders.edges).toEqual([]);
    expect(errorCodeOf(await gql(CANCEL_ORDER, { input: { id: orderId } }, { as: "other" }))).toBe("NOT_FOUND");
  });

  it("cancels its order", async () => {
    expect(orderId).toBeDefined();
    dataOf(await gql(CANCEL_ORDER, { input: { id: orderId } }, asAnonymous()));
    expect((await getOrder())?.status).toBe("CANCELLED");
  });
});
