import env from "./config/env.ts";
import { createApp } from "./app.ts";
import { productionProviders, setupFlags } from "./flags/index.ts";
import { createShutdown } from "./shutdown.ts";
import { logger } from "./utils/logger.ts";

const PORT = env.PORT;
const HOST = env.HOST;

// Feature flags first: waits at most a couple of seconds for the providers,
// then the API starts on the registry defaults if they aren't ready.
await setupFlags({ providers: productionProviders() });

const { httpServer, server } = await createApp();

await new Promise<void>((resolve) => httpServer.listen({ port: Number(PORT), host: HOST }, resolve));

logger.info("Server ready", { url: `http://${HOST}:${PORT}/graphql` });

const shutdown = createShutdown(server);
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
