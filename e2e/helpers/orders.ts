import { randomUUID } from "node:crypto";
import type { E2EUser } from "./auth.js";
import { dataOf, gql, type GraphQLResult } from "./graphql.js";

// The steps of a purchase as the app takes them, for the tests that buy.

export const ADD_TO_CART = `mutation AddToCart($input: AddToCart!) {
  addToCart(input: $input) { success data { id productId quantity unitPrice } }
}`;
export const REMOVE_FROM_CART = `mutation RemoveFromCart($input: RemoveFromCart!) {
  removeFromCart(input: $input) { success }
}`;
export const CREATE_ORDER = `mutation CreateOrder($input: CreateOrder!) {
  createOrder(input: $input) { success data { id status } }
}`;
export const UPDATE_ORDER = `mutation UpdateOrder($input: UpdateOrder!) {
  updateOrder(input: $input) { success data { status } }
}`;
export const CANCEL_ORDER = `mutation CancelOrder($input: CancelOrder!) {
  cancelOrder(input: $input) { success }
}`;
export const CREATE_ORDER_PAYMENT = `mutation CreateOrderPayment($input: CreateOrderPayment!) {
  createOrderPayment(input: $input) { success data { paymentId clientSecret } }
}`;
export const ORDER = `query Order($id: ID) {
  orders(id: $id) {
    edges { node { id status paymentId totals { currency total } details { id productId quantity } } }
  }
}`;

export interface OrderNode {
  id: string;
  status: "INCOMPLETE" | "PAYMENT_PENDING" | "COMPLETE" | "CANCELLED";
  paymentId: string | null;
  totals: { currency: string; total: number };
  details: { id: string; productId: string; quantity: number }[];
}

export const TEST_CUSTOMER = { name: "E2E Test", phone: "5555555555" };
export const TEST_ADDRESS = {
  address: "Av. Siempre Viva 742",
  zipCode: "01000",
  coords: { latitude: 19.4326, longitude: -99.1332, latitudeDelta: 0.01, longitudeDelta: 0.01 },
};

// Every cart the suite creates starts with e2e-, so its data is easy to tell
// apart from real orders.
export const newCartId = () => `e2e-${randomUUID()}`;

export const getOrder = async (id: string, as: E2EUser = "main"): Promise<OrderNode | undefined> =>
  dataOf(await gql<{ orders: { edges: { node: OrderNode }[] } }>(ORDER, { id }, { as })).orders.edges[0]?.node;

// A cart with one product turned into an order with its delivery details,
// ready to pay (PAYMENT_PENDING).
export const placeOrder = async ({
  productId,
  quantity,
  email,
  as = "main",
}: {
  productId: string;
  quantity: number;
  email: string;
  as?: E2EUser;
}) => {
  const cartId = newCartId();
  dataOf(await gql(ADD_TO_CART, { input: { cartId, productId, quantity } }, { as }));
  const created = dataOf(
    await gql<{ createOrder: { data: { id: string; status: string } } }>(CREATE_ORDER, { input: { cartId } }, { as })
  ).createOrder.data;
  const updated = dataOf(
    await gql<{ updateOrder: { data: { status: string } } }>(
      UPDATE_ORDER,
      { input: { id: created.id, customer: { ...TEST_CUSTOMER, email }, address: TEST_ADDRESS } },
      { as }
    )
  ).updateOrder.data;
  return { cartId, orderId: created.id, createdStatus: created.status, status: updated.status };
};

type PaymentData = { createOrderPayment: { data: { paymentId: string; clientSecret: string } } };

const extensionsOf = (result: GraphQLResult<unknown>) => result.errors?.[0]?.extensions ?? {};

// createOrderPayment the way the app calls it. It may refuse to charge
// without an error on our side, and the app knows what to do:
//   - priceChanges: the items already moved to the new price; pay again.
//   - expiredItemIds: those reservations expired; remove the items and add
//     them back to the order, which reserves again, then pay.
// Anything else (unavailableProductIds included) fails the test.
export const payOrder = async (
  orderId: string,
  { cartId, as = "main", attempts = 3 }: { cartId: string; as?: E2EUser; attempts?: number }
) => {
  const recovered: string[] = [];
  for (let attempt = 1; ; attempt += 1) {
    const result = await gql<PaymentData>(CREATE_ORDER_PAYMENT, { input: { orderId } }, { as });
    const { priceChanges, expiredItemIds } = extensionsOf(result) as {
      priceChanges?: unknown[];
      expiredItemIds?: string[];
    };
    if (attempt < attempts && priceChanges) {
      recovered.push("priceChanges");
      continue;
    }
    if (attempt < attempts && expiredItemIds) {
      recovered.push("expiredItemIds");
      const order = await getOrder(orderId, as);
      for (const item of order?.details.filter((d) => expiredItemIds.includes(d.id)) ?? []) {
        dataOf(await gql(REMOVE_FROM_CART, { input: { id: item.id } }, { as }));
        dataOf(
          await gql(
            ADD_TO_CART,
            { input: { cartId, orderId, productId: item.productId, quantity: item.quantity } },
            { as }
          )
        );
      }
      continue;
    }
    return { ...dataOf(result).createOrderPayment.data, recovered, requestId: result.requestId };
  }
};
