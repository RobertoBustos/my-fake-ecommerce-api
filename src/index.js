import env from "./config/env.js";
import { createApp } from "./app.js";
import { logger } from "./utils/logger.js";

const PORT = env.PORT;
const HOST = env.HOST;

const { httpServer } = await createApp();

await new Promise((resolve) => httpServer.listen({ port: PORT, host: HOST }, resolve));

logger.info("Server ready", { url: `http://${HOST}:${PORT}/graphql` });
