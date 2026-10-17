import { describe, it, expect, vi } from "vitest";
import { ApolloServer } from "@apollo/server";
import {
  checkAddToCart,
  checkCancelOrder,
  checkCreateOrder,
  checkCreateOrderPayment,
  checkRemoveFromCart,
  checkUpdateOrder,
} from "../src/schema/validators/index.js";

const customer = { email: "ana@example.com", name: "Ana", phone: "5512345678" };
const address = {
  address: "Av. Reforma 1",
  zipCode: "06600",
  coords: { latitude: 19.43, longitude: -99.13, latitudeDelta: 0.01, longitudeDelta: 0.01 },
};

describe("checkUpdateOrder", () => {
  it("accepts complete customer and address details", () => {
    expect(checkUpdateOrder({ id: "order-1", customer, address })).toBeNull();
  });

  it("accepts customer or address alone", () => {
    expect(checkUpdateOrder({ id: "order-1", customer })).toBeNull();
    expect(checkUpdateOrder({ id: "order-1", address })).toBeNull();
  });

  it("needs customer or address", () => {
    expect(checkUpdateOrder({ id: "order-1" })).toBe("customer");
    expect(checkUpdateOrder({ id: "order-1", customer: null, address: null })).toBe("customer");
  });

  it.each([
    ["customer.email", { customer: { ...customer, email: "not-an-email" } }],
    ["customer.name", { customer: { ...customer, name: "   " } }],
    ["customer.phone", { customer: { ...customer, phone: "55-1234" } }],
    ["customer.phone", { customer: { ...customer, phone: "call me" } }],
    ["address.address", { address: { ...address, address: "" } }],
    ["address.zipCode", { address: { ...address, zipCode: "" } }],
    ["address.coords.latitude", { address: { ...address, coords: { ...address.coords, latitude: 91 } } }],
    [
      "address.coords.longitude",
      { address: { ...address, coords: { ...address.coords, longitude: -181 } } },
    ],
    [
      "address.coords.latitudeDelta",
      { address: { ...address, coords: { ...address.coords, latitudeDelta: -1 } } },
    ],
  ])("rejects an invalid %s", (field, changes) => {
    expect(checkUpdateOrder({ id: "order-1", ...changes })).toBe(field);
  });

  it("rejects a blank id", () => {
    expect(checkUpdateOrder({ id: "  ", customer })).toBe("id");
  });
});

describe("id-only inputs", () => {
  it.each([
    [checkCreateOrder, "cartId"],
    [checkCreateOrderPayment, "orderId"],
    [checkCancelOrder, "id"],
    [checkRemoveFromCart, "id"],
  ])("%o rejects a blank or missing %s", (check, field) => {
    expect(check({ [field]: "" })).toBe(field);
    expect(check({})).toBe(field);
    expect(check({ [field]: "abc" })).toBeNull();
  });
});

describe("checkAddToCart", () => {
  const valid = { cartId: "cart-1", productId: "1", quantity: 2 };

  it("accepts a valid item, with or without an order", () => {
    expect(checkAddToCart(valid)).toBeNull();
    expect(checkAddToCart({ ...valid, orderId: "order-1" })).toBeNull();
  });

  it.each([
    ["quantity", { quantity: 0 }],
    ["quantity", { quantity: 1.5 }],
    ["cartId", { cartId: "" }],
    ["orderId", { orderId: "" }],
  ])("rejects an invalid %s", (field, changes) => {
    expect(checkAddToCart({ ...valid, ...changes })).toBe(field);
  });
});

describe("invalid input through GraphQL", () => {
  it("answers BAD_USER_INPUT naming the field, and never reaches Stripe", async () => {
    vi.resetModules();
    const getCustomer = vi.fn();
    vi.doMock("../src/db/payment.js", () => ({
      cancelPayment: vi.fn(),
      createPayment: vi.fn(),
      getCustomer,
      searchPayment: vi.fn(),
      searchPaymentMethod: vi.fn(),
    }));
    const typeDefs = (await import("../src/schema/typeDefs/index.js")).default;
    const resolvers = (await import("../src/schema/resolvers.js")).default;
    const { createLoaders } = await import("../src/dataloaders/index.js");
    const server = new ApolloServer({ typeDefs, resolvers });

    const response = await server.executeOperation(
      {
        query: `mutation ($input: UpdateOrder!) { updateOrder(input: $input) { success } }`,
        variables: {
          input: { id: "any-order", customer: { ...customer, email: "nope" }, address },
        },
      },
      { contextValue: { user: { uid: "validation-user" }, loaders: createLoaders() } }
    );

    expect(response.body.singleResult.errors[0].extensions).toEqual({
      code: "BAD_USER_INPUT",
      invalidArgument: "customer.email",
    });
    expect(getCustomer).not.toHaveBeenCalled();
    vi.doUnmock("../src/db/payment.js");
  });
});
