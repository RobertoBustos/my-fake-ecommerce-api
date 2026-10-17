import type { ApolloServer } from "@apollo/server";
import { logger } from "./utils/logger.js";

// Cloud Run sends SIGTERM on every deploy and scale-down, then kills the
// instance 10 seconds later. In-flight requests get most of that window.
export const SHUTDOWN_GRACE_PERIOD_MS = 8000;

// server.stop() runs the drain plugin: the HTTP server stops accepting
// connections, in-flight requests (GraphQL and the webhook alike) finish, and
// whatever is still open after the grace period is closed.
export const createShutdown = (
  server: Pick<ApolloServer<never>, "stop">,
  { exit = process.exit as (code: number) => void } = {}
) => {
  let stopping: Promise<void> | undefined;
  return (signal: string) => {
    stopping ??= (async () => {
      logger.info("Shutting down", { signal });
      try {
        await server.stop();
        logger.info("Shutdown complete");
        exit(0);
      } catch (err) {
        const error = err as Error;
        logger.error("Shutdown failed", { error: error.message, stack: error.stack });
        exit(1);
      }
    })();
    return stopping;
  };
};
