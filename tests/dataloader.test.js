import { describe, it, expect, afterAll, vi } from "vitest";
import { randomUUID } from "crypto";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";
import { createLoaders } from "../src/dataloaders/index.js";
import db from "../src/config/firestore.js";
import * as productsDb from "../src/db/products.js";
import { addToCart, updateCartItems } from "../src/db/cart.js";
import { createOrder } from "../src/db/orders.js";

describe("DataLoader de productos y totales (H10)", () => {
  const cartId = `cart-dataloader-${randomUUID()}`;
  const productIds = Array.from(
    { length: 5 },
    (_, i) => `test-product-${randomUUID()}-${i}`
  );
  let orderId;

  afterAll(async () => {
    await Promise.all(
      productIds.map((id) => db.collection("products").doc(id).delete())
    );
    if (orderId) {
      await db.collection("orders").doc(orderId).delete();
    }
    const cartItems = await db
      .collection("cartItems")
      .where("cartId", "==", cartId)
      .get();
    await Promise.all(cartItems.docs.map((doc) => doc.ref.delete()));
  });

  it("una orden de N renglones hace una sola lectura batch de productos", async () => {
    await Promise.all(
      productIds.map((id) =>
        db
          .collection("products")
          .doc(id)
          .set({ unitPrice: 100, stock: 10, purchaseLimits: { min: 1, max: 10 } })
      )
    );
    for (const id of productIds) {
      await addToCart({ id, unitPrice: 100 }, { cartId, productId: id, quantity: 1 });
    }
    const order = await createOrder({ cartId }, "test-user");
    orderId = order.id;
    await updateCartItems(cartId, orderId);

    const spy = vi.spyOn(productsDb, "getProductsByIds");

    const server = new ApolloServer({ typeDefs, resolvers });
    const response = await server.executeOperation(
      {
        query: `query ($id: ID!) {
          orders(id: $id) {
            edges {
              node {
                totals { items total }
                details { product { id } }
              }
            }
          }
        }`,
        variables: { id: orderId },
      },
      { contextValue: { loaders: createLoaders(), user: { uid: "test-user" } } }
    );

    const { data, errors } = response.body.singleResult;
    expect(errors).toBeUndefined();
    const node = data.orders.edges[0].node;
    expect(node.details).toHaveLength(productIds.length);
    expect(node.totals.items).toBe(productIds.length);
    // N renglones, pero una sola llamada batch a Firestore por los productos.
    expect(spy).toHaveBeenCalledTimes(1);
  }, 15000);
});
