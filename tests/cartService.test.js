import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  addToCartDbMock,
  getProductsMock,
  removeFromCartDbMock,
  addToCartValidatorMock,
  removeFromCartValidatorMock,
  validateCartQuantityMock,
  InsufficientStockErrorStub,
} = vi.hoisted(() => {
  class InsufficientStockErrorStub extends Error {}
  return {
    addToCartDbMock: vi.fn(),
    getProductsMock: vi.fn(),
    removeFromCartDbMock: vi.fn(),
    addToCartValidatorMock: vi.fn(),
    removeFromCartValidatorMock: vi.fn(),
    validateCartQuantityMock: vi.fn(),
    InsufficientStockErrorStub,
  };
});

vi.mock("../src/db/index.js", () => ({
  addToCart: addToCartDbMock,
  getProducts: getProductsMock,
  removeFromCart: removeFromCartDbMock,
  InsufficientStockError: InsufficientStockErrorStub,
}));

vi.mock("../src/schema/validators/index.js", () => ({
  addToCartValidator: addToCartValidatorMock,
  removeFromCartValidator: removeFromCartValidatorMock,
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
    addToCartValidatorMock.mockReturnValue(true);
    validateCartQuantityMock.mockReturnValue(true);
    getProductsMock.mockResolvedValue([product]);
  });

  it("rechaza un input inválido antes de tocar la base de datos", async () => {
    addToCartValidatorMock.mockReturnValue(false);

    await expect(addToCart({ productId: "x" })).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    expect(getProductsMock).not.toHaveBeenCalled();
  });

  it("falla si el producto no existe", async () => {
    getProductsMock.mockResolvedValue([]);

    await expect(
      addToCart({ productId: "missing", quantity: 1 })
    ).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND", invalidArgument: "productId" },
    });
  });

  it("falla si la cantidad está fuera de los límites de compra", async () => {
    validateCartQuantityMock.mockReturnValue(false);

    await expect(
      addToCart({ productId: product.id, quantity: 99 })
    ).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT", invalidArgument: "quantity" },
    });
  });

  it("traduce InsufficientStockError a un error de usuario", async () => {
    addToCartDbMock.mockRejectedValue(new InsufficientStockErrorStub());

    await expect(
      addToCart({ productId: product.id, quantity: 1 })
    ).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT", invalidArgument: "quantity" },
    });
  });

  it("deja pasar cualquier otro error de la base de datos sin envolver", async () => {
    const dbError = new Error("firestore unavailable");
    addToCartDbMock.mockRejectedValue(dbError);

    await expect(
      addToCart({ productId: product.id, quantity: 1 })
    ).rejects.toBe(dbError);
  });

  it("agrega el producto al carrito en el camino feliz", async () => {
    const cartItem = { id: "cart-item-1", productId: product.id, quantity: 2 };
    addToCartDbMock.mockResolvedValue(cartItem);

    const result = await addToCart({ productId: product.id, quantity: 2 });

    expect(addToCartDbMock).toHaveBeenCalledWith(product, {
      productId: product.id,
      quantity: 2,
    });
    expect(result).toEqual({
      code: 200,
      success: true,
      message: "Product added",
      data: cartItem,
    });
  });
});

describe("cartService.removeFromCart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeFromCartValidatorMock.mockReturnValue(true);
  });

  it("rechaza un input inválido", async () => {
    removeFromCartValidatorMock.mockReturnValue(false);

    await expect(removeFromCart({ id: "bad" })).rejects.toMatchObject({
      extensions: { code: "BAD_REQUEST" },
    });
    expect(removeFromCartDbMock).not.toHaveBeenCalled();
  });

  it("reporta éxito cuando la base de datos elimina el item", async () => {
    removeFromCartDbMock.mockResolvedValue(true);

    const result = await removeFromCart({ id: "cart-item-1" });

    expect(result).toEqual({
      code: 200,
      success: true,
      message: "Item Removed",
    });
  });

  it("reporta el fallo cuando la base de datos no logra eliminar el item", async () => {
    removeFromCartDbMock.mockResolvedValue(false);

    const result = await removeFromCart({ id: "cart-item-1" });

    expect(result).toEqual({
      code: 200,
      success: false,
      message: "There was an error removing the item",
    });
  });
});
