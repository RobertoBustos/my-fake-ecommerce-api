// Every check* validator returns null for valid input, or the path of the
// first invalid field ("customer.email", "quantity"...), which the services
// return to the client as extensions.invalidArgument.
export const firstInvalidField = (schema, input) => {
  const result = schema.safeParse(input);
  if (result.success) {
    return null;
  }
  const path = result.error.issues[0].path.join(".");
  return path === "" ? "input" : path;
};
