import { describe, it, expect, vi } from "vitest";
import { spawn } from "child_process";
import { once } from "events";
import { ESLint } from "eslint";
import { exporterCredentials } from "../src/observability/exporterAuth.js";
import { onTelemetryShutdown } from "../src/observability/lifecycle.js";
import { telemetryRequested } from "../src/observability/sdkCommon.js";
import { createShutdown, TRACE_FLUSH_TIMEOUT_MS } from "../src/shutdown.js";
import { getLocalIdToken } from "../scripts/localToken.js";

// Starts the API in a child process, the way the Dockerfile does: tracing is
// loaded first with --import. `telemetry` is the module that starts it.
const startServer = async (telemetry, port, env = {}) => {
  const child = spawn(process.execPath, ["--import", "tsx", "--import", telemetry, "src/index.ts"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", OTEL_BSP_SCHEDULE_DELAY: "50", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(...String(chunk).split("\n").filter(Boolean)));
  child.stderr.on("data", (chunk) => stderr.push(...String(chunk).split("\n").filter(Boolean)));
  await vi.waitFor(() => expect(stdout.join("\n")).toMatch(/Server ready/), { timeout: 15000 });
  return {
    url: `http://127.0.0.1:${port}`,
    logs: () => stdout.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)),
    // Printed by tests/helpers/tracingProbe.js.
    spans: () => stderr.filter((line) => line.startsWith("SPAN ")).map((line) => JSON.parse(line.slice(5))),
    stop: async () => {
      child.kill("SIGTERM");
      const [code] = await once(child, "exit");
      return code;
    },
  };
};

describe("OpenTelemetry tracing", () => {
  it("is off unless an OTLP endpoint is configured", () => {
    expect(telemetryRequested("traces", {})).toBe(false);
    expect(telemetryRequested("traces", { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example" })).toBe(true);
    expect(telemetryRequested("traces", { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example" })).toBe(
      true
    );
    // A signal's own endpoint turns on only that signal.
    expect(telemetryRequested("metrics", { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example" })).toBe(
      false
    );
    expect(
      telemetryRequested("traces", { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example", OTEL_SDK_DISABLED: "true" })
    ).toBe(false);
  });

  it("starts and stops the API with tracing off", async () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "" };
    const server = await startServer("./src/telemetry.ts", 18766, env);
    const response = await fetch(`${server.url}/healthcheck`);
    expect(response.status).toBe(200);
    expect(await server.stop()).toBe(0);
    expect(server.logs().map((log) => log.message)).toContain("Shutdown complete");
  }, 30000);

  it("traces a GraphQL request named after its operation, without its variables, linked to its logs", async () => {
    const server = await startServer("./tests/helpers/tracingProbe.js", 18767, {
      GOOGLE_CLOUD_PROJECT: "demo-ecommerce-api",
    });
    const { idToken: token } = await getLocalIdToken({ email: "tracing-test@example.com" });
    const graphql = (body) =>
      fetch(`${server.url}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const listed = await graphql({
      operationName: "TracedProducts",
      query: "query TracedProducts($first: Int) { products(first: $first) { edges { node { id } } } }",
      variables: { first: 1 },
    });
    expect(listed.status).toBe(200);
    // A value sent as a variable and another written inline (both as cursors,
    // which fail validation without echoing them back).
    const secret = "do-not-trace-this-value";
    await graphql({
      operationName: "WithSecrets",
      query: `query WithSecrets($after: String) {
        byVariable: products(first: 1, after: $after) { edges { node { id } } }
        inline: products(first: 1, after: "${secret}-inline") { edges { node { id } } }
      }`,
      variables: { after: secret },
    });
    await fetch(`${server.url}/healthcheck`);

    await vi.waitFor(
      () =>
        expect(server.spans().map((span) => span.name)).toEqual(
          expect.arrayContaining(["graphql TracedProducts", "graphql WithSecrets"])
        ),
      { timeout: 5000 }
    );
    expect(await server.stop()).toBe(0);
    const spans = server.spans();

    // One trace: the server span is its root, named after the operation.
    const root = spans.find((span) => span.name === "graphql TracedProducts");
    expect(root.parentSpanId).toBeUndefined();
    const trace = spans.filter((span) => span.traceId === root.traceId);
    expect(trace.map((span) => span.name)).toEqual(
      expect.arrayContaining(["query TracedProducts", "graphql.resolve products"])
    );
    // Firestore, over gRPC, and Express's middleware: each instrumentation
    // still patches its module with the ESM hook limited to them.
    expect(trace.some((span) => span.attributes["rpc.system"] === "grpc")).toBe(true);
    expect(trace.some((span) => span.name.startsWith("middleware - "))).toBe(true);

    // Neither the variables nor values written inline in the query.
    expect(JSON.stringify(spans)).not.toContain(secret);
    // Nor the client's IP, which the HTTP instrumentation records.
    for (const key of ["client.address", "http.client_ip"]) {
      expect(spans.filter((span) => key in span.attributes)).toEqual([]);
    }
    // The health check isn't traced, nor is the schema parse at startup.
    expect(spans.some((span) => span.attributes["url.path"] === "/healthcheck")).toBe(false);
    expect(spans.some((span) => span.name === "graphql.parseSchema")).toBe(false);

    // The request's log lines carry the trace and a span of it.
    const summary = server.logs().find((log) => log.message === "GraphQL operation" && log.operationName === "TracedProducts");
    expect(summary["logging.googleapis.com/trace"]).toBe(`projects/demo-ecommerce-api/traces/${root.traceId}`);
    expect(trace.map((span) => span.spanId)).toContain(summary["logging.googleapis.com/spanId"]);
  }, 30000);

  it("still exits when the last spans can't be sent", async () => {
    vi.useFakeTimers();
    try {
      onTelemetryShutdown(() => new Promise(() => {}));
      const exit = vi.fn();
      const stopping = createShutdown({ stop: async () => {} }, { exit })("SIGTERM");
      await vi.advanceTimersByTimeAsync(TRACE_FLUSH_TIMEOUT_MS);
      await stopping;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OTLP exporter credentials", () => {
  it("leaves the exporter's defaults (OTEL_EXPORTER_OTLP_HEADERS) when TELEMETRY_AUTH isn't set", () => {
    expect(exporterCredentials({})).toBeUndefined();
  });

  it("builds Google credentials only when asked", () => {
    expect(exporterCredentials({ TELEMETRY_AUTH: "google" })).toBeDefined();
  });

  it("rejects an unknown value instead of exporting without credentials", () => {
    expect(() => exporterCredentials({ TELEMETRY_AUTH: "datadog" })).toThrow(/Unknown TELEMETRY_AUTH/);
  });
});

describe("OpenTelemetry stays in src/observability/", () => {
  const eslint = new ESLint();
  const lint = async (filePath) => {
    const [result] = await eslint.lintText('import { trace } from "@opentelemetry/api";\nexport const t = trace;\n', {
      filePath,
    });
    return result.messages.filter((message) => message.ruleId === "no-restricted-imports");
  };

  it.each([
    "src/services/tracedService.ts",
    "src/schema/resolvers/traced.ts",
    "src/catalog/traced.ts",
    "src/search/adapters/algolia/traced.ts",
    "src/jobs/traced.ts",
    "scripts/traced.ts",
  ])("rejects an import from %s", async (filePath) => {
    const messages = await lint(filePath);
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatch(/Only src\/observability\/ may use OpenTelemetry/);
  });

  it("allows it in src/observability/", async () => {
    expect(await lint("src/observability/traced.ts")).toEqual([]);
  });
});
