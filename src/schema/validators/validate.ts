// Every check* validator returns null for valid input, or the path of the
// first invalid field ("customer.email", "quantity"...), which the services
// return to the client as extensions.invalidArgument.
import type { ZodType } from "zod";

export type Check<T = unknown> = (input: T) => string | null;

export const firstInvalidField = (schema: ZodType, input: unknown): string | null => {
  const result = schema.safeParse(input);
  if (result.success) {
    return null;
  }
  const path = result.error.issues[0].path.join(".");
  return path === "" ? "input" : path;
};
