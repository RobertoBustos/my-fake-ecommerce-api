import { GraphQLError } from "graphql";
import { SourceUnavailableError } from "../catalog/ports.js";
import { TransactionContentionError } from "../db/index.js";
import { ExchangeRateUnavailableError, quotePrice, type PriceQuote } from "../pricing/index.js";

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

// A price in the settlement currency. Without a usable exchange rate the
// product can't be sold for now; the rates job runs daily, so it's worth
// retrying later (the missing rate is already logged as an ERROR).
export const quoteOrConflict = async (price: {
  unitPrice: number;
  currency: string | null | undefined;
}): Promise<PriceQuote> => {
  try {
    return await quotePrice(price);
  } catch (err) {
    if (err instanceof ExchangeRateUnavailableError) {
      throw new GraphQLError(`Prices in ${err.from} can't be converted right now, please try again later`, {
        extensions: { code: "CONFLICT", retryable: true },
      });
    }
    throw err;
  }
};

// Runs a call that reaches a catalog source live (reading a product's
// current price and stock, reserving units). A source that can't answer
// right now is worth retrying: the product stays listed from the catalog
// index, it just can't be sold this moment.
export const withSourceRetryHint = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof SourceUnavailableError) {
      throw new GraphQLError("This product's catalog can't be reached right now, please try again", {
        extensions: { code: "CONFLICT", retryable: true },
      });
    }
    throw err;
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
