import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  cancelOrderDbMock,
  createOrderDbMock,
  createPaymentMock,
  getCartMock,
  getOrderTotalsMock,
  getOrdersMock,
  setOrderPaymentMock,
  updateOrderDbMock,
  checkCancelOrderMock,
  checkCreateOrderPaymentMock,
  checkCreateOrderMock,
  checkUpdateOrderMock,
  CartAlreadyOrderedError,
  OrderAlreadyCompleteError,
  OrderClosedError,
  TransactionContentionError,
} = vi.hoisted(() => ({
  cancelOrderDbMock: vi.fn(),
  createOrderDbMock: vi.fn(),
  createPaymentMock: vi.fn(),
  getCartMock: vi.fn(),
  getOrderTotalsMock: vi.fn(),
  getOrdersMock: vi.fn(),
  setOrderPaymentMock: vi.fn(),
  updateOrderDbMock: vi.fn(),
  checkCancelOrderMock: vi.fn(),
  checkCreateOrderPaymentMock: vi.fn(),
  checkCreateOrderMock: vi.fn(),
  checkUpdateOrderMock: vi.fn(),
  CartAlreadyOrderedError: class CartAlreadyOrderedError extends Error {},
  OrderAlreadyCompleteError: class OrderAlreadyCompleteError extends Error {},
  OrderClosedError: class OrderClosedError extends Error {
    constructor(orderId, status) {
      super(`Order ${orderId} is ${status}`);
      this.status = status;
    }
  },
  TransactionContentionError: class TransactionContentionError extends Error {},
}));

vi.mock("../src/db/index.js", () => ({
  cancelOrder: cancelOrderDbMock,
  CartAlreadyOrderedError,
  createOrder: createOrderDbMock,
  createPayment: createPaymentMock,
  getCart: getCartMock,
  getOrderTotals: getOrderTotalsMock,
  getOrders: getOrdersMock,
  OrderAlreadyCompleteError,
  OrderClosedError,
  TransactionContentionError,
  setOrderPayment: setOrderPaymentMock,
  updateOrder: updateOrderDbMock,
}));

vi.mock("../src/schema/validators/index.js", () => ({
  checkCancelOrder: checkCancelOrderMock,
  checkCreateOrderPayment: checkCreateOrderPaymentMock,
  checkCreateOrder: checkCreateOrderMock,
  checkUpdateOrder: checkUpdateOrderMock,
}));

const { cancelOrder, createOrder, createOrderPayment, updateOrder } =
  await import("../src/services/orderService.js");

describe("orderService.createOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkCreateOrderMock.mockReturnValue(null);
  });

  it("rejects an invalid input", async () => {
    checkCreateOrderMock.mockReturnValue("id");

    await expect(createOrder({ cartId: "x" })).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT", invalidArgument: "id" },
    });
    expect(getCartMock).not.toHaveBeenCalled();
  });

  it("fails when the cart doesn't exist", async () => {
    getCartMock.mockResolvedValue([]);

    await expect(
      createOrder({ cartId: "missing-cart" })
    ).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND", invalidArgument: "cartId" },
    });
  });

  it("creates the order and links the cart items", async () => {
    getCartMock.mockResolvedValue([{ id: "item-1", userId: "user-1" }]);
    const order = { id: "order-1", status: "INCOMPLETE" };
    createOrderDbMock.mockResolvedValue(order);

    const result = await createOrder({ cartId: "cart-1" }, "user-1");

    expect(createOrderDbMock).toHaveBeenCalledWith(
      { cartId: "cart-1" },
      "user-1"
    );
    expect(result).toEqual({
      code: 200,
      success: true,
      message: "Order created",
      data: order,
    });
  });

  it("rejects a cart whose items have all been ordered", async () => {
    getCartMock.mockResolvedValue([{ id: "item-1", userId: "user-1", orderId: "order-0" }]);
    createOrderDbMock.mockRejectedValue(new CartAlreadyOrderedError("cart-1"));

    await expect(createOrder({ cartId: "cart-1" }, "user-1")).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT", invalidArgument: "cartId" },
    });
  });
});

describe("orderService.updateOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkUpdateOrderMock.mockReturnValue(null);
  });

  it("rejects an invalid input", async () => {
    checkUpdateOrderMock.mockReturnValue("id");

    await expect(updateOrder({ id: "x" })).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT", invalidArgument: "id" },
    });
    expect(getOrdersMock).not.toHaveBeenCalled();
  });

  it("fails when the order doesn't exist", async () => {
    getOrdersMock.mockResolvedValue([]);

    await expect(updateOrder({ id: "missing" })).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND", invalidArgument: "id" },
    });
  });

  it("reports failure when the update couldn't be applied", async () => {
    getOrdersMock.mockResolvedValue([{ id: "order-1" }]);
    updateOrderDbMock.mockResolvedValue(null);

    const result = await updateOrder({ id: "order-1" });

    expect(result).toEqual({
      code: 200,
      success: false,
      message: "There was an error updating the order",
      data: null,
    });
  });

  it("updates the order on the happy path", async () => {
    getOrdersMock.mockResolvedValue([{ id: "order-1" }]);
    const updated = { id: "order-1", status: "PAYMENT_PENDING" };
    updateOrderDbMock.mockResolvedValue(updated);

    const result = await updateOrder({ id: "order-1" });

    expect(result).toEqual({
      code: 200,
      success: true,
      message: "Order updated",
      data: updated,
    });
  });
});

describe("orderService.updateOrder on a closed order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkUpdateOrderMock.mockReturnValue(null);
    getOrdersMock.mockResolvedValue([{ id: "order-1", status: "COMPLETE" }]);
  });

  it("answers a domain error instead of reopening the order", async () => {
    updateOrderDbMock.mockRejectedValue(new OrderClosedError("order-1", "COMPLETE"));

    await expect(updateOrder({ id: "order-1" }, "user-1")).rejects.toMatchObject({
      message: "A COMPLETE order can't be updated",
      extensions: { code: "BAD_USER_INPUT", invalidArgument: "id" },
    });
  });
});

describe("orderService.cancelOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkCancelOrderMock.mockReturnValue(null);
  });

  it("rejects an invalid input", async () => {
    checkCancelOrderMock.mockReturnValue("id");

    await expect(cancelOrder({ id: "x" })).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT", invalidArgument: "id" },
    });
    expect(cancelOrderDbMock).not.toHaveBeenCalled();
  });

  it("reports success when the order is cancelled", async () => {
    cancelOrderDbMock.mockResolvedValue(true);

    const result = await cancelOrder({ id: "order-1" });

    expect(result).toEqual({
      code: 200,
      success: true,
      message: "Order cancelled",
    });
  });

  it("rejects cancelling a paid order with a domain error", async () => {
    cancelOrderDbMock.mockRejectedValue(new OrderAlreadyCompleteError("order-1"));

    await expect(cancelOrder({ id: "order-1" })).rejects.toMatchObject({
      message: "A paid order can't be cancelled",
      extensions: { code: "BAD_USER_INPUT", invalidArgument: "id" },
    });
  });

  it("reports failure when the cancellation couldn't be applied", async () => {
    cancelOrderDbMock.mockResolvedValue(false);

    const result = await cancelOrder({ id: "order-1" });

    expect(result).toEqual({
      code: 200,
      success: false,
      message: "There was an error cancelling the order",
    });
  });
});

describe("orderService.createOrderPayment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkCreateOrderPaymentMock.mockReturnValue(null);
  });

  it("rejects an invalid input", async () => {
    checkCreateOrderPaymentMock.mockReturnValue("id");

    await expect(createOrderPayment({ orderId: "x" })).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT", invalidArgument: "id" },
    });
    expect(getOrdersMock).not.toHaveBeenCalled();
  });

  it("fails when the order doesn't exist", async () => {
    getOrdersMock.mockResolvedValue([]);

    await expect(
      createOrderPayment({ orderId: "missing" })
    ).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND", invalidArgument: "orderId" },
    });
  });

  it("fails when the order has no customer information", async () => {
    getOrdersMock.mockResolvedValue([{ id: "order-1", customer: null }]);

    await expect(
      createOrderPayment({ orderId: "order-1" })
    ).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND", invalidArgument: "order.customer" },
    });
  });

  it("creates the payment on the happy path", async () => {
    getOrdersMock.mockResolvedValue([
      { id: "order-1", status: "PAYMENT_PENDING", customer: { id: "cus-1" } },
    ]);
    getOrderTotalsMock.mockResolvedValue({ total: 500 });
    const payment = { paymentId: "pi_1", clientSecret: "secret_1" };
    createPaymentMock.mockResolvedValue(payment);

    const result = await createOrderPayment({ orderId: "order-1" });

    expect(createPaymentMock).toHaveBeenCalledWith("order-1", 500, "cus-1");
    expect(setOrderPaymentMock).toHaveBeenCalledWith("order-1", "pi_1");
    expect(result).toEqual({
      code: 200,
      success: true,
      message: "Payment created",
      data: payment,
    });
  });

  it.each(["INCOMPLETE", "COMPLETE", "CANCELLED"])(
    "refuses to charge an order that is %s",
    async (status) => {
      getOrdersMock.mockResolvedValue([{ id: "order-1", status, customer: { id: "cus-1" } }]);

      await expect(createOrderPayment({ orderId: "order-1" })).rejects.toMatchObject({
        extensions: { code: "BAD_USER_INPUT", invalidArgument: "orderId" },
      });
      expect(createPaymentMock).not.toHaveBeenCalled();
    }
  );

  it("refuses to charge an order with nothing to pay", async () => {
    getOrdersMock.mockResolvedValue([
      { id: "order-1", status: "PAYMENT_PENDING", customer: { id: "cus-1" } },
    ]);
    getOrderTotalsMock.mockResolvedValue({ total: 0 });

    await expect(createOrderPayment({ orderId: "order-1" })).rejects.toMatchObject({
      message: "The order has no items to pay for",
      extensions: { code: "BAD_USER_INPUT" },
    });
    expect(createPaymentMock).not.toHaveBeenCalled();
  });
});
