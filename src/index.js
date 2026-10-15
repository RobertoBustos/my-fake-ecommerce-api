import env from "./config/env.js";
import { createApp } from "./app.js";

const PORT = env.PORT;
const HOST = env.HOST;

const { httpServer } = await createApp();

await new Promise((resolve) => httpServer.listen({ port: PORT, host: HOST }, resolve));

console.log(`🚀  Server ready at: http://${HOST}:${PORT}/graphql`);
