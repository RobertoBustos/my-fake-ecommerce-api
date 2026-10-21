import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireEnv } from "./helpers/env.js";
import { dataOf, errorCodeOf, gql, report } from "./helpers/graphql.js";
import { CANCEL_ORDER, getOrder, payOrder, placeOrder, UPDATE_ORDER, TEST_ADDRESS, type OrderNode } from "./helpers/orders.js";
import { getStripe } from "./helpers/stripe.js";
import { waitFor } from "./helpers/waitFor.js";

const PRODUCT = `query Product($id: ID) {
  products(id: $id) { edges { node { id stock purchaseLimits { min } } } }
}`;

// Stripe confirms in a second or two; the webhook usually lands a few
// seconds later. The test waits up to a minute before calling it a failure.
const WEBHOOK_TIMEOUT_MS = 60_000;

describe("purchase against the deployed API", () => {
  const productId = requireEnv("E2E_PRODUCT_ID");
  const email = requireEnv("E2E_EMAIL");
  let quantity = 1;
  let orderId: string | undefined;
  let cartId: string | undefined;
  let paymentId: string | undefined;
  let paymentRequestId: string | null = null;

  beforeAll(async () => {
    const { products } = dataOf(
      await gql<{ products: { edges: { node: { stock: number; purchaseLimits: { min: number } } }[] } }>(PRODUCT, {
        id: productId,
      })
    );
    quantity = products.edges[0].node.purchaseLimits.min;
  });

  // An order the run left halfway gives its units back; a COMPLETE one
  // can't be cancelled, and its unit stays sold.
  afterAll(async () => {
    if (!orderId) return;
    const order = await getOrder(orderId);
    if (order && order.status !== "COMPLETE" && order.status !== "CANCELLED") {
      await gql(CANCEL_ORDER, { input: { id: orderId } });
    }
  });

  it("places an order ready to pay", async () => {
    const placed = await placeOrder({ productId, quantity, email });
    ({ orderId, cartId } = placed);
    expect(placed.createdStatus).toBe("INCOMPLETE");
    expect(placed.status).toBe("PAYMENT_PENDING");
  });

  it("creates the payment and Stripe charges the order's total", async () => {
    expect(orderId).toBeDefined();
    const payment = await payOrder(orderId as string, { cartId: cartId as string });
    paymentId = payment.paymentId;
    paymentRequestId = payment.requestId;
    expect(paymentId).toMatch(/^pi_/);
    if (payment.recovered.length > 0) report(`createOrderPayment asked to retry: ${payment.recovered.join(", ")}`);

    const order = (await getOrder(orderId as string)) as OrderNode;
    expect(order.paymentId).toBe(paymentId);
    const intent = await getStripe().paymentIntents.retrieve(paymentId);
    expect(intent.amount).toBe(order.totals.total);
    expect(intent.currency).toBe(order.totals.currency.toLowerCase());
    expect(intent.metadata.order_id).toBe(orderId);
  });

  it(
    "completes the order through the Stripe webhook once the payment is confirmed",
    async () => {
      expect(paymentId).toBeDefined();
      // What the Payment Sheet does in the app, done server side with
      // Stripe's test card.
      const confirmed = await getStripe().paymentIntents.confirm(paymentId as string, {
        payment_method: "pm_card_visa",
      });
      expect(confirmed.status).toBe("succeeded");

      const order = await waitFor(
        () => getOrder(orderId as string),
        (o) => o?.status === "COMPLETE",
        { timeoutMs: WEBHOOK_TIMEOUT_MS, intervalMs: 2_000, description: `order ${orderId} to be COMPLETE` }
      );
      expect(order?.status).toBe("COMPLETE");
      report(`Order ${orderId} COMPLETE: payment ${paymentId}, createOrderPayment X-Request-Id ${paymentRequestId}`);
    },
    WEBHOOK_TIMEOUT_MS + 30_000
  );

  it("doesn't let a paid order change or be cancelled", async () => {
    expect((await getOrder(orderId as string))?.status).toBe("COMPLETE");
    const updated = await gql(UPDATE_ORDER, { input: { id: orderId, address: TEST_ADDRESS } });
    expect(errorCodeOf(updated)).toBe("BAD_USER_INPUT");
    const cancelled = await gql(CANCEL_ORDER, { input: { id: orderId } });
    expect(errorCodeOf(cancelled)).toBe("BAD_USER_INPUT");
  });
});
