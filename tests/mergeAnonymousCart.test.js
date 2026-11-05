import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { ApolloServer } from "@apollo/server";
import { getAuth } from "firebase-admin/auth";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";
import { createLoaders } from "../src/dataloaders/index.js";
import db, { firebaseApp } from "../src/config/firestore.js";
import { toGlobalProductId } from "../src/catalog/index.js";

// Real tokens from the Auth emulator: what's under test is that the mutation
// tells an anonymous token from any other one.
const signUp = async (body) => {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const response = await fetch(
    `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, returnSecureToken: true }),
    }
  );
  const { idToken, localId } = await response.json();
  return { token: idToken, uid: localId };
};
const newAnonymous = () => signUp({});

const server = new ApolloServer({ typeDefs, resolvers });
const run = async (uid, query, variables) => {
  const response = await server.executeOperation(
    { query, variables },
    { contextValue: { user: { uid }, loaders: createLoaders() } }
  );
  return response.body.singleResult;
};
const errorCode = (result) => result.errors?.[0]?.extensions?.code;

const ADD_TO_CART = `mutation ($input: AddToCart!) {
  addToCart(input: $input) { data { id } }
}`;
const CREATE_ORDER = `mutation ($input: CreateOrder!) {
  createOrder(input: $input) { data { id } }
}`;
const MERGE = `mutation ($input: MergeAnonymousCart!) {
  mergeAnonymousCart(input: $input) {
    success
    released { productId quantity }
    data { id cartId productId quantity subtotal product { id } }
  }
}`;

const MAX = 5;
const STOCK = 20;
const UNIT_PRICE = 100;

const add = async (uid, cartId, productId, quantity) => {
  const result = await run(uid, ADD_TO_CART, { input: { cartId, productId, quantity } });
  expect(result.errors).toBeUndefined();
  return result.data.addToCart.data.id;
};
const stockOf = async (productId) =>
  (await db.collection("products").doc(productId).get()).get("stock");
const freeItemsOf = async (uid) =>
  db.collection("cartItems").where("userId", "==", uid).where("orderId", "==", null).get();

describe("mergeAnonymousCart", () => {
  const products = [`test-merge-a-${randomUUID()}`, `test-merge-b-${randomUUID()}`];
  const [repeated, other] = products;
  const carts = [];
  const newCart = () => {
    const cartId = `cart-merge-${randomUUID()}`;
    carts.push(cartId);
    return cartId;
  };
  let account;

  beforeAll(async () => {
    account = await signUp({ email: `merge-${randomUUID()}@example.com`, password: "local-test-password" });
    await Promise.all(
      products.map((id) =>
        db.collection("products").doc(id).set({
          title: id,
          unitPrice: UNIT_PRICE,
          currency: "MXN",
          stock: STOCK,
          purchaseLimits: { min: 1, max: MAX },
        })
      )
    );
  });

  afterAll(async () => {
    const orders = await db.collection("orders").where("cart", "in", carts.slice(-30)).get();
    await Promise.all(orders.docs.map((doc) => doc.ref.delete()));
    for (const cartId of carts) {
      const items = await db.collection("cartItems").where("cartId", "==", cartId).get();
      await Promise.all(items.docs.map((doc) => doc.ref.delete()));
    }
    await Promise.all(products.map((id) => db.collection("products").doc(id).delete()));
  });

  it("moves two products and sums the repeated one, keeping its reservations and the stock", async () => {
    const anonymous = await newAnonymous();
    const cartId = newCart();
    await add(account.uid, cartId, repeated, 2);
    await add(anonymous.uid, newCart(), repeated, 1);
    const otherItem = await add(anonymous.uid, carts.at(-1), other, 3);
    const stock = [await stockOf(repeated), await stockOf(other)];

    const result = await run(account.uid, MERGE, {
      input: { anonymousIdToken: anonymous.token, cartId },
    });

    expect(result.errors).toBeUndefined();
    const { data, released } = result.data.mergeAnonymousCart;
    expect(released).toEqual([]);
    const byProduct = new Map(data.map((item) => [item.productId, item]));
    expect(data).toHaveLength(2);
    expect(byProduct.get(toGlobalProductId("fs", repeated))).toMatchObject({
      cartId,
      quantity: 3,
      subtotal: 3 * UNIT_PRICE,
      product: { id: toGlobalProductId("fs", repeated) },
    });
    expect(byProduct.get(toGlobalProductId("fs", other))).toMatchObject({ id: otherItem, cartId, quantity: 3 });

    expect((await freeItemsOf(anonymous.uid)).empty).toBe(true);
    expect([await stockOf(repeated), await stockOf(other)]).toEqual(stock);
    const summed = await db.collection("cartItems").doc(byProduct.get(toGlobalProductId("fs", repeated)).id).get();
    expect(summed.get("userId")).toBe(account.uid);
    expect(summed.get("reservationIds")).toHaveLength(2);
    expect(summed.get("reservations").map((r) => r.quantity).sort()).toEqual([1, 2]);
  });

  it("is idempotent: a second call doesn't duplicate items", async () => {
    const anonymous = await newAnonymous();
    const cartId = newCart();
    await add(anonymous.uid, newCart(), repeated, 2);
    const input = { anonymousIdToken: anonymous.token, cartId };

    const first = await run(account.uid, MERGE, { input });
    const second = await run(account.uid, MERGE, { input });

    expect(second.errors).toBeUndefined();
    expect(second.data.mergeAnonymousCart.data).toEqual(first.data.mergeAnonymousCart.data);
    expect((await db.collection("cartItems").where("cartId", "==", cartId).get()).size).toBe(1);
  });

  it("gives back and reports a reservation that doesn't fit the purchase limit", async () => {
    const anonymous = await newAnonymous();
    const cartId = newCart();
    await add(account.uid, cartId, repeated, 4);
    await add(anonymous.uid, newCart(), repeated, 3);
    const stock = await stockOf(repeated);

    const result = await run(account.uid, MERGE, {
      input: { anonymousIdToken: anonymous.token, cartId },
    });

    expect(result.errors).toBeUndefined();
    const { data, released } = result.data.mergeAnonymousCart;
    expect(data).toEqual([expect.objectContaining({ quantity: 4 })]);
    expect(released).toEqual([{ productId: toGlobalProductId("fs", repeated), quantity: 3 }]);
    expect(await stockOf(repeated)).toBe(stock + 3);
    expect((await freeItemsOf(anonymous.uid)).empty).toBe(true);
  });

  it("keeps the reservations that fit when only some of them don't", async () => {
    const anonymous = await newAnonymous();
    const cartId = newCart();
    const anonymousCart = newCart();
    await add(account.uid, cartId, repeated, 3);
    await add(anonymous.uid, anonymousCart, repeated, 1);
    await add(anonymous.uid, anonymousCart, repeated, 2);
    const stock = await stockOf(repeated);

    const result = await run(account.uid, MERGE, {
      input: { anonymousIdToken: anonymous.token, cartId },
    });

    const { data, released } = result.data.mergeAnonymousCart;
    expect(data).toEqual([expect.objectContaining({ quantity: 4 })]);
    expect(released).toEqual([{ productId: toGlobalProductId("fs", repeated), quantity: 2 }]);
    expect(await stockOf(repeated)).toBe(stock + 2);
  });

  it("takes over the same cartId the anonymous user was using", async () => {
    const anonymous = await newAnonymous();
    const cartId = newCart();
    const itemId = await add(anonymous.uid, cartId, other, 1);

    const result = await run(account.uid, MERGE, {
      input: { anonymousIdToken: anonymous.token, cartId },
    });

    expect(result.errors).toBeUndefined();
    expect(result.data.mergeAnonymousCart.data).toEqual([expect.objectContaining({ id: itemId, cartId })]);
    // The account owns the cart now, so it can keep adding to it.
    await add(account.uid, cartId, repeated, 1);
  });

  it("leaves the anonymous user's orders alone", async () => {
    const anonymous = await newAnonymous();
    const orderedCart = newCart();
    const orderedItem = await add(anonymous.uid, orderedCart, other, 1);
    const created = await run(anonymous.uid, CREATE_ORDER, { input: { cartId: orderedCart } });
    expect(created.errors).toBeUndefined();
    await add(anonymous.uid, newCart(), repeated, 1);

    const result = await run(account.uid, MERGE, {
      input: { anonymousIdToken: anonymous.token, cartId: newCart() },
    });

    expect(result.data.mergeAnonymousCart.data).toEqual([
      expect.objectContaining({ productId: toGlobalProductId("fs", repeated) }),
    ]);
    const ordered = await db.collection("cartItems").doc(orderedItem).get();
    expect(ordered.get("userId")).toBe(anonymous.uid);
    expect(ordered.get("orderId")).toBe(created.data.createOrder.data.id);
  });

  it("answers NOT_FOUND for a cart the account could never use", async () => {
    const anonymous = await newAnonymous();
    const stranger = await newAnonymous();
    const foreignCart = newCart();
    await add(stranger.uid, foreignCart, other, 1);
    await add(anonymous.uid, newCart(), other, 1);

    const foreign = await run(account.uid, MERGE, {
      input: { anonymousIdToken: anonymous.token, cartId: foreignCart },
    });
    expect(errorCode(foreign)).toBe("NOT_FOUND");
    expect((await freeItemsOf(anonymous.uid)).size).toBe(1);

    const orderedCart = newCart();
    await add(anonymous.uid, orderedCart, repeated, 1);
    await run(anonymous.uid, CREATE_ORDER, { input: { cartId: orderedCart } });
    const ordered = await run(account.uid, MERGE, {
      input: { anonymousIdToken: anonymous.token, cartId: orderedCart },
    });
    expect(errorCode(ordered)).toBe("NOT_FOUND");
  });

  it("answers BAD_USER_INPUT for the token of an account with an email", async () => {
    const result = await run("another-user", MERGE, {
      input: { anonymousIdToken: account.token, cartId: newCart() },
    });
    expect(errorCode(result)).toBe("BAD_USER_INPUT");
    expect(result.errors[0].extensions.invalidArgument).toBe("anonymousIdToken");
  });

  it("answers BAD_USER_INPUT when the anonymous user is the caller", async () => {
    const anonymous = await newAnonymous();
    const result = await run(anonymous.uid, MERGE, {
      input: { anonymousIdToken: anonymous.token, cartId: newCart() },
    });
    expect(errorCode(result)).toBe("BAD_USER_INPUT");
  });

  it("answers UNAUTHENTICATED for an invalid token", async () => {
    const result = await run(account.uid, MERGE, {
      input: { anonymousIdToken: "not-a-token", cartId: newCart() },
    });
    expect(errorCode(result)).toBe("UNAUTHENTICATED");
  });

  it("answers UNAUTHENTICATED for the token of a deleted anonymous user", async () => {
    const anonymous = await newAnonymous();
    await getAuth(firebaseApp).deleteUser(anonymous.uid);
    const result = await run(account.uid, MERGE, {
      input: { anonymousIdToken: anonymous.token, cartId: newCart() },
    });
    expect(errorCode(result)).toBe("UNAUTHENTICATED");
  });
});
