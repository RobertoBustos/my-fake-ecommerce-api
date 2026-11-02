import type { ApolloServer } from "@apollo/server";
import { shutdownTracing } from "./observability/spans.js";
import { logger } from "./utils/logger.js";

// Cloud Run sends SIGTERM on every deploy and scale-down, then kills the
// instance 10 seconds later. In-flight requests get most of that window.
export const SHUTDOWN_GRACE_PERIOD_MS = 8000;

// What's left after the grace period, before Cloud Run kills the instance, to
// send the spans still buffered. Past it they're dropped and the exit goes on.
export const TRACE_FLUSH_TIMEOUT_MS = 1500;

// server.stop() runs the drain plugin: the HTTP server stops accepting
// connections, in-flight requests (GraphQL and the webhook alike) finish, and
// whatever is still open after the grace period is closed.
const flushTraces = () =>
  Promise.race([
    shutdownTracing().catch((err: Error) => logger.warn("Could not send the last traces", { error: err.message })),
    new Promise((resolve) => setTimeout(resolve, TRACE_FLUSH_TIMEOUT_MS)),
  ]);

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
        await flushTraces();
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
