export const createOrderValidator = (input) => {
  if (!input || !input.cartId || input.cartId === "") {
    return false;
  }
  return true;
};

export const cancelOrderValidator = (input) => {
  if (!input || !input.id || input.id === "") {
    return false;
  }
  return true;
};
