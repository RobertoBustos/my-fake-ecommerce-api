import { GraphQLError } from "graphql";
import { TransactionContentionError } from "../db/index.js";

// Runs a stock write and turns a lost lock fight into a domain error the
// client can retry, instead of the generic INTERNAL_SERVER_ERROR.
export const withContentionRetryHint = async (operation) => {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof TransactionContentionError) {
      throw new GraphQLError("Too many people are buying this right now, please try again", {
        extensions: { code: "CONFLICT", retryable: true },
      });
    }
    throw err;
  }
};
