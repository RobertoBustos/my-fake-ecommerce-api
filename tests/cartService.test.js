import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  addToCartDbMock,
  getProductsMock,
  removeFromCartDbMock,
  checkAddToCartMock,
  checkRemoveFromCartMock,
  validateCartQuantityMock,
  InsufficientStockErrorStub,
  CartNotOwnedErrorStub,
  TransactionContentionErrorStub,
  getOrdersMock,
} = vi.hoisted(() => {
  class InsufficientStockErrorStub extends Error {}
  class CartNotOwnedErrorStub extends Error {}
  class TransactionContentionErrorStub extends Error {}
  return {
    TransactionContentionErrorStub,
    CartNotOwnedErrorStub,
    getOrdersMock: vi.fn(),
    addToCartDbMock: vi.fn(),
    getProductsMock: vi.fn(),
    removeFromCartDbMock: vi.fn(),
    checkAddToCartMock: vi.fn(),
    checkRemoveFromCartMock: vi.fn(),
    validateCartQuantityMock: vi.fn(),
    InsufficientStockErrorStub,
  };
});

vi.mock("../src/db/index.js", () => ({
  addToCart: addToCartDbMock,
  CartNotOwnedError: CartNotOwnedErrorStub,
  getOrders: getOrdersMock,
  getProducts: getProductsMock,
  removeFromCart: removeFromCartDbMock,
  InsufficientStockError: InsufficientStockErrorStub,
  TransactionContentionError: TransactionContentionErrorStub,
}));

vi.mock("../src/schema/validators/index.js", () => ({
  checkAddToCart: checkAddToCartMock,
  checkRemoveFromCart: checkRemoveFromCartMock,
  validateCartQuantity: validateCartQuantityMock,
}));

const { addToCart, removeFromCart } = await import(
  "../src/services/cartService.js"
);

const product = {
  id: "prod-1",
  purchaseLimits: { min: 1, max: 5 },
  stock: 3,
};

describe("cartService.addToCart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkAddToCartMock.mockReturnValue(null);
    validateCartQuantityMock.mockReturnValue(true);
    getProductsMock.mockResolvedValue([product]);
  });

  it("rejects an invalid input before touching the database", async () => {
    checkAddToCartMock.mockReturnValue("id");

    await expect(addToCart({ productId: "x" })).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    expect(getProductsMock).not.toHaveBeenCalled();
  });

  it("fails when the product doesn't exist", async () => {
    getProductsMock.mockResolvedValue([]);

    await expect(
      addToCart({ productId: "missing", quantity: 1 })
    ).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND", invalidArgument: "productId" },
    });
  });

  it("fails when quantity is outside purchase limits", async () => {
    validateCartQuantityMock.mockReturnValue(false);

    await expect(
      addToCart({ productId: product.id, quantity: 99 })
    ).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT", invalidArgument: "quantity" },
    });
  });

  it("translates InsufficientStockError into a user-facing error", async () => {
    addToCartDbMock.mockRejectedValue(new InsufficientStockErrorStub());

    await expect(
      addToCart({ productId: product.id, quantity: 1 })
    ).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT", invalidArgument: "quantity" },
    });
  });

  it("answers NOT_FOUND when the cart belongs to another user", async () => {
    addToCartDbMock.mockRejectedValue(new CartNotOwnedErrorStub());

    await expect(
      addToCart({ productId: product.id, quantity: 1, cartId: "cart-a" }, "user-b")
    ).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND", invalidArgument: "cartId" },
    });
  });

  it("answers NOT_FOUND when the orderId belongs to another user", async () => {
    getOrdersMock.mockResolvedValue([]);

    await expect(
      addToCart({ productId: product.id, quantity: 1, orderId: "order-a" }, "user-b")
    ).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND", invalidArgument: "orderId" },
    });
    expect(getOrdersMock).toHaveBeenCalledWith({ id: "order-a", userId: "user-b" });
    expect(addToCartDbMock).not.toHaveBeenCalled();
  });

  it("turns a lost lock fight into a retryable CONFLICT", async () => {
    addToCartDbMock.mockRejectedValue(new TransactionContentionErrorStub());

    await expect(
      addToCart({ productId: product.id, quantity: 1 }, "user-1")
    ).rejects.toMatchObject({
      extensions: { code: "CONFLICT", retryable: true },
    });
  });

  it("lets any other database error pass through unwrapped", async () => {
    const dbError = new Error("firestore unavailable");
    addToCartDbMock.mockRejectedValue(dbError);

    await expect(
      addToCart({ productId: product.id, quantity: 1 })
    ).rejects.toBe(dbError);
  });

  it("adds the product to the cart on the happy path", async () => {
    const cartItem = { id: "cart-item-1", productId: product.id, quantity: 2 };
    addToCartDbMock.mockResolvedValue(cartItem);

    const result = await addToCart({ productId: product.id, quantity: 2 }, "user-1");

    expect(addToCartDbMock).toHaveBeenCalledWith(
      product,
      { productId: product.id, quantity: 2 },
      "user-1"
    );
    expect(result).toEqual({
      code: "200",
      success: true,
      message: "Product added",
      data: cartItem,
    });
  });
});

describe("cartService.removeFromCart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRemoveFromCartMock.mockReturnValue(null);
  });

  it("rejects an invalid input", async () => {
    checkRemoveFromCartMock.mockReturnValue("id");

    await expect(removeFromCart({ id: "bad" })).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT", invalidArgument: "id" },
    });
    expect(removeFromCartDbMock).not.toHaveBeenCalled();
  });

  it("reports success when the database removes the item", async () => {
    removeFromCartDbMock.mockResolvedValue(true);

    const result = await removeFromCart({ id: "cart-item-1" });

    expect(result).toEqual({
      code: "200",
      success: true,
      message: "Item Removed",
    });
  });

  it("answers NOT_FOUND when the item is missing or belongs to someone else", async () => {
    removeFromCartDbMock.mockResolvedValue(false);

    await expect(removeFromCart({ id: "cart-item-1" }, "user-b")).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND", invalidArgument: "id" },
    });
    expect(removeFromCartDbMock).toHaveBeenCalledWith({ id: "cart-item-1" }, "user-b");
  });
});
