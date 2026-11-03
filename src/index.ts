import env from "./config/env.ts";
import { createApp } from "./app.ts";
import { createShutdown } from "./shutdown.ts";
import { logger } from "./utils/logger.ts";

const PORT = env.PORT;
const HOST = env.HOST;

const { httpServer, server } = await createApp();

await new Promise<void>((resolve) => httpServer.listen({ port: Number(PORT), host: HOST }, resolve));

logger.info("Server ready", { url: `http://${HOST}:${PORT}/graphql` });

const shutdown = createShutdown(server);
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
