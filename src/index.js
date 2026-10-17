import env from "./config/env.js";
import { createApp } from "./app.js";
import { createShutdown } from "./shutdown.js";
import { logger } from "./utils/logger.js";

const PORT = env.PORT;
const HOST = env.HOST;

const { httpServer, server } = await createApp();

await new Promise((resolve) => httpServer.listen({ port: PORT, host: HOST }, resolve));

logger.info("Server ready", { url: `http://${HOST}:${PORT}/graphql` });

const shutdown = createShutdown(server);
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
