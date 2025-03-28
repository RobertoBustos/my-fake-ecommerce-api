export const addToCartValidator = (input) => {
  if (
    !input ||
    !input.cartId ||
    input.cartId === "" ||
    !input.productId ||
    input.productId === "" ||
    !input.quantity ||
    input.quantity === 0
  ) {
    return false;
  }
  return true;
};

export const removeFromCartValidator = (input) => {
  if (!input || !input.id || input.id === "") {
    return false;
  }
  return true;
};
