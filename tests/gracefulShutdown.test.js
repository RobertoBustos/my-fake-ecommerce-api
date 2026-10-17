import { describe, it, expect, vi } from "vitest";
import { spawn } from "child_process";
import { once } from "events";
import { createShutdown } from "../src/shutdown.js";

vi.mock("../src/auth/verifyIdToken.js", () => ({
  verifyIdToken: vi.fn().mockResolvedValue({ uid: "shutdown-user" }),
}));

const { createApp } = await import("../src/app.js");

describe("graceful shutdown", () => {
  it("lets an in-flight request finish, then stops accepting connections", async () => {
    const { app, httpServer, server } = await createApp();
    let release;
    app.get("/slow-for-test", (_req, res) => {
      release = () => res.status(200).json({ done: true });
    });
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${httpServer.address().port}`;

    const inFlight = fetch(`${url}/slow-for-test`);
    await vi.waitFor(() => expect(release).toBeDefined());

    const exit = vi.fn();
    const stopping = createShutdown(server, { exit })("SIGTERM");
    // Still draining: the request hasn't been answered yet.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(exit).not.toHaveBeenCalled();

    release();
    const response = await inFlight;
    expect(response.status).toBe(200);
    await stopping;
    expect(exit).toHaveBeenCalledWith(0);
    expect(httpServer.listening).toBe(false);
  });

  it("calling it twice (SIGTERM, then SIGINT) stops only once", async () => {
    const stop = vi.fn().mockResolvedValue();
    const exit = vi.fn();
    const shutdown = createShutdown({ stop }, { exit });

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("the real server exits with 0 on SIGTERM", async () => {
    // tsx runs the TypeScript sources directly, as `npm run dev` does.
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      env: { ...process.env, PORT: "18765", HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = [];
    child.stdout.on("data", (chunk) => lines.push(...String(chunk).split("\n").filter(Boolean)));
    await vi.waitFor(() => expect(lines.join("\n")).toMatch(/Server ready/), { timeout: 10000 });

    child.kill("SIGTERM");
    const [code] = await once(child, "exit");

    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/Shutdown complete/);
  }, 20000);
});
