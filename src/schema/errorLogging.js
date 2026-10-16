import { logger } from "../utils/logger.js";

// formatError hides the details of unexpected errors from the client; this
// plugin keeps them in the logs. Known domain errors (with their own code)
// are expected behavior, not failures, so they aren't logged.
export const errorLoggingPlugin = {
  async requestDidStart() {
    return {
      async didEncounterErrors({ errors }) {
        for (const error of errors) {
          const code = error.extensions?.code;
          if (code && code !== "INTERNAL_SERVER_ERROR") continue;
          const original = error.originalError ?? error;
          logger.error(original.message, {
            path: error.path?.join("."),
            stack: original.stack,
          });
        }
      },
    };
  },
};
