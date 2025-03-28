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
    !input.customer ||
    !input.customer.email ||
    input.customer.email === "" ||
    !input.customer.name ||
    input.customer.name === ""
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
