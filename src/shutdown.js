import { logger } from "./utils/logger.js";

// Cloud Run sends SIGTERM on every deploy and scale-down, then kills the
// instance 10 seconds later. In-flight requests get most of that window.
export const SHUTDOWN_GRACE_PERIOD_MS = 8000;

// server.stop() runs the drain plugin: the HTTP server stops accepting
// connections, in-flight requests (GraphQL and the webhook alike) finish, and
// whatever is still open after the grace period is closed.
export const createShutdown = (server, { exit = process.exit } = {}) => {
  let stopping;
  return (signal) => {
    stopping ??= (async () => {
      logger.info("Shutting down", { signal });
      try {
        await server.stop();
        logger.info("Shutdown complete");
        exit(0);
      } catch (err) {
        logger.error("Shutdown failed", { error: err.message, stack: err.stack });
        exit(1);
      }
    })();
    return stopping;
  };
};
