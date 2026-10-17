import { GraphQLError } from "graphql";
import { TransactionContentionError } from "../db/index.js";

// Throws BAD_USER_INPUT, naming the field, when a check* validator (see
// schema/validators) rejects the input.
export const assertValidInput = (check: (input: unknown) => string | null, input: unknown) => {
  const invalidArgument = check(input);
  if (invalidArgument) {
    throw new GraphQLError("One or more parameters sent have an invalid value", {
      extensions: { code: "BAD_USER_INPUT", invalidArgument },
    });
  }
};

// Runs a contended write (stock, order status) and turns a lost lock fight
// into a domain error the client can retry, instead of the generic
// INTERNAL_SERVER_ERROR.
export const withContentionRetryHint = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof TransactionContentionError) {
      throw new GraphQLError("Someone else changed this at the same time, please try again", {
        extensions: { code: "CONFLICT", retryable: true },
      });
    }
    throw err;
  }
};
