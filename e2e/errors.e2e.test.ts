import { afterAll, describe, expect, it } from "vitest";
import { requireEnv } from "./helpers/env.js";
import { dataOf, errorCodeOf, gql, type GraphQLResult } from "./helpers/graphql.js";
import {
  ADD_TO_CART,
  CANCEL_ORDER,
  CREATE_ORDER,
  CREATE_ORDER_PAYMENT,
  getOrder,
  newCartId,
  ORDER,
  payOrder,
  placeOrder,
  TEST_ADDRESS,
  TEST_CUSTOMER,
  UPDATE_ORDER,
} from "./helpers/orders.js";
import { getStripe } from "./helpers/stripe.js";

// What has to fail, and fail cleanly, in the deployed API. Every order these
// tests place ends up cancelled, so the e2e product gets its units back.

const productId = requireEnv("E2E_PRODUCT_ID");
const email = requireEnv("E2E_EMAIL");

const placed: string[] = [];
const place = async () => {
  const order = await placeOrder({ productId, quantity: 1, email });
  placed.push(order.orderId);
  return order;
};

afterAll(async () => {
  for (const id of placed) {
    const order = await getOrder(id);
    if (order && order.status !== "COMPLETE" && order.status !== "CANCELLED") {
      await gql(CANCEL_ORDER, { input: { id } });
    }
  }
});

const invalidArgumentOf = (result: GraphQLResult<unknown>) => result.errors?.[0]?.extensions?.invalidArgument;

// The webhook only acts on payment_intent.succeeded, so a declined payment
// leaves nothing to wait for; a few seconds are enough to be sure nothing
// completed the order by mistake.
const DECLINE_SETTLE_MS = 5_000;

describe("declined payment", () => {
  it(
    "leaves the order PAYMENT_PENDING when the card is declined",
    async () => {
      const { orderId, cartId } = await place();
      const { paymentId } = await payOrder(orderId, { cartId });

      const declined = await getStripe()
        .paymentIntents.confirm(paymentId, { payment_method: "pm_card_chargeDeclined" })
        .then(
          () => null,
          (err: { code?: string; decline_code?: string }) => err
        );
      expect(declined).toMatchObject({ code: "card_declined" });
      expect((await getStripe().paymentIntents.retrieve(paymentId)).status).toBe("requires_payment_method");

      await new Promise((resolve) => setTimeout(resolve, DECLINE_SETTLE_MS));
      expect((await getOrder(orderId))?.status).toBe("PAYMENT_PENDING");
    },
    DECLINE_SETTLE_MS + 30_000
  );
});

describe("cancelling an unpaid order", () => {
  it("cancels it, and cancelling it again changes nothing", async () => {
    const { orderId, cartId } = await place();
    const { paymentId } = await payOrder(orderId, { cartId });

    const first = dataOf(await gql<{ cancelOrder: { success: boolean } }>(CANCEL_ORDER, { input: { id: orderId } }));
    expect(first.cancelOrder.success).toBe(true);
    expect((await getOrder(orderId))?.status).toBe("CANCELLED");
    // The order's PaymentIntent is cancelled too, so it can't be paid later.
    expect((await getStripe().paymentIntents.retrieve(paymentId)).status).toBe("canceled");

    const again = dataOf(await gql<{ cancelOrder: { success: boolean } }>(CANCEL_ORDER, { input: { id: orderId } }));
    expect(again.cancelOrder.success).toBe(true);
    expect((await getOrder(orderId))?.status).toBe("CANCELLED");

    const pay = await gql(CREATE_ORDER_PAYMENT, { input: { orderId } });
    expect(errorCodeOf(pay)).toBe("BAD_USER_INPUT");
  });
});

describe("input validation", () => {
  it("rejects a quantity that isn't a positive integer in addToCart", async () => {
    const result = await gql(ADD_TO_CART, { input: { cartId: newCartId(), productId, quantity: 0 } });
    expect(errorCodeOf(result)).toBe("BAD_USER_INPUT");
    expect(invalidArgumentOf(result)).toBe("quantity");
  });

  it("rejects an empty product id in addToCart", async () => {
    const result = await gql(ADD_TO_CART, { input: { cartId: newCartId(), productId: " ", quantity: 1 } });
    expect(errorCodeOf(result)).toBe("BAD_USER_INPUT");
    expect(invalidArgumentOf(result)).toBe("productId");
  });

  it("rejects an invalid email and zip code in updateOrder, naming the field", async () => {
    const { orderId } = await place();
    const badEmail = await gql(UPDATE_ORDER, {
      input: { id: orderId, customer: { ...TEST_CUSTOMER, email: "not-an-email" } },
    });
    expect(errorCodeOf(badEmail)).toBe("BAD_USER_INPUT");
    expect(invalidArgumentOf(badEmail)).toBe("customer.email");

    const badZip = await gql(UPDATE_ORDER, { input: { id: orderId, address: { ...TEST_ADDRESS, zipCode: "#" } } });
    expect(errorCodeOf(badZip)).toBe("BAD_USER_INPUT");
    expect(invalidArgumentOf(badZip)).toBe("address.zipCode");
  });

  it("rejects a page larger than 100 in products", async () => {
    const result = await gql(`query { products(first: 101) { edges { node { id } } } }`);
    expect(errorCodeOf(result)).toBe("BAD_USER_INPUT");
  });
});

describe("ownership between users", () => {
  it("hides one user's order from another, and refuses to change it", async () => {
    const { orderId, cartId } = await place();

    // Reads return an empty list rather than an error, so a foreign id looks
    // exactly like one that doesn't exist (H2).
    const read = dataOf(await gql<{ orders: { edges: unknown[] } }>(ORDER, { id: orderId }, { as: "other" }));
    expect(read.orders.edges).toEqual([]);
    const cart = dataOf(
      await gql<{ carts: { edges: unknown[] } }>(
        `query Cart($cartId: String) { carts(cartId: $cartId) { edges { node { id } } } }`,
        { cartId },
        { as: "other" }
      )
    );
    expect(cart.carts.edges).toEqual([]);

    const attempts = await Promise.all([
      gql(UPDATE_ORDER, { input: { id: orderId, address: TEST_ADDRESS } }, { as: "other" }),
      gql(CANCEL_ORDER, { input: { id: orderId } }, { as: "other" }),
      gql(CREATE_ORDER_PAYMENT, { input: { orderId } }, { as: "other" }),
      gql(CREATE_ORDER, { input: { cartId } }, { as: "other" }),
    ]);
    for (const attempt of attempts) expect(errorCodeOf(attempt)).toBe("NOT_FOUND");

    // And none of it touched the order.
    expect((await getOrder(orderId))?.status).toBe("PAYMENT_PENDING");
  });
});
