export const productValidator = (input) => {
  if (!input || !input.id || input.id === "") {
    return false;
  }
  return true;
};
