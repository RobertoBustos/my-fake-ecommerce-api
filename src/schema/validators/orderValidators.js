export const createOrderValidator = (input) => {
  if (!input || !input.cartId || input.cartId === "") {
    return false;
  }
  return true;
};

export const updateOrderValidator = (input) => {
  if (
    !input ||
    !input.id ||
    input.id === "" ||
    (input.customer === null && input.address === null && input.status === null)
  ) {
    return false;
  }
  return true;
};

export const createOrderPaymentValidator = (input) => {
  if (!input || !input.orderId || input.orderId === "") {
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
