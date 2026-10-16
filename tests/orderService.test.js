import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  cancelOrderDbMock,
  createOrderDbMock,
  createPaymentMock,
  getCartMock,
  getOrderTotalsMock,
  getOrdersMock,
  setOrderPaymentMock,
  updateCartItemsMock,
  updateOrderDbMock,
  cancelOrderValidatorMock,
  createOrderPaymentValidatorMock,
  createOrderValidatorMock,
  updateOrderValidatorMock,
  OrderAlreadyCompleteError,
} = vi.hoisted(() => ({
  cancelOrderDbMock: vi.fn(),
  createOrderDbMock: vi.fn(),
  createPaymentMock: vi.fn(),
  getCartMock: vi.fn(),
  getOrderTotalsMock: vi.fn(),
  getOrdersMock: vi.fn(),
  setOrderPaymentMock: vi.fn(),
  updateCartItemsMock: vi.fn(),
  updateOrderDbMock: vi.fn(),
  cancelOrderValidatorMock: vi.fn(),
  createOrderPaymentValidatorMock: vi.fn(),
  createOrderValidatorMock: vi.fn(),
  updateOrderValidatorMock: vi.fn(),
  OrderAlreadyCompleteError: class OrderAlreadyCompleteError extends Error {},
}));

vi.mock("../src/db/index.js", () => ({
  cancelOrder: cancelOrderDbMock,
  createOrder: createOrderDbMock,
  createPayment: createPaymentMock,
  getCart: getCartMock,
  getOrderTotals: getOrderTotalsMock,
  getOrders: getOrdersMock,
  OrderAlreadyCompleteError,
  setOrderPayment: setOrderPaymentMock,
  updateCartItems: updateCartItemsMock,
  updateOrder: updateOrderDbMock,
}));

vi.mock("../src/schema/validators/index.js", () => ({
  cancelOrderValidator: cancelOrderValidatorMock,
  createOrderPaymentValidator: createOrderPaymentValidatorMock,
  createOrderValidator: createOrderValidatorMock,
  updateOrderValidator: updateOrderValidatorMock,
}));

const { cancelOrder, createOrder, createOrderPayment, updateOrder } =
  await import("../src/services/orderService.js");

describe("orderService.createOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createOrderValidatorMock.mockReturnValue(true);
  });

  it("rejects an invalid input", async () => {
    createOrderValidatorMock.mockReturnValue(false);

    await expect(createOrder({ cartId: "x" })).rejects.toMatchObject({
      extensions: { code: "BAD_REQUEST" },
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
    expect(updateCartItemsMock).toHaveBeenCalledWith("cart-1", "order-1");
    expect(result).toEqual({
      code: 200,
      success: true,
      message: "Order created",
      data: order,
    });
  });
});

describe("orderService.updateOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateOrderValidatorMock.mockReturnValue(true);
  });

  it("rejects an invalid input", async () => {
    updateOrderValidatorMock.mockReturnValue(false);

    await expect(updateOrder({ id: "x" })).rejects.toMatchObject({
      extensions: { code: "BAD_REQUEST" },
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

describe("orderService.cancelOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cancelOrderValidatorMock.mockReturnValue(true);
  });

  it("rejects an invalid input", async () => {
    cancelOrderValidatorMock.mockReturnValue(false);

    await expect(cancelOrder({ id: "x" })).rejects.toMatchObject({
      extensions: { code: "BAD_REQUEST" },
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
    createOrderPaymentValidatorMock.mockReturnValue(true);
  });

  it("rejects an invalid input", async () => {
    createOrderPaymentValidatorMock.mockReturnValue(false);

    await expect(createOrderPayment({ orderId: "x" })).rejects.toMatchObject({
      extensions: { code: "BAD_REQUEST" },
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
      { id: "order-1", customer: { id: "cus-1" } },
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
});
