import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn } from "child_process";
import { once } from "events";
import request from "supertest";
import { metrics as otelMetrics } from "@opentelemetry/api";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import db from "../src/config/firestore.js";
import { measureInventoryQueue } from "../src/catalog/inventoryQueue.js";
import { writeExchangeRates } from "../src/db/pricing.js";
import { boundedLabel, metrics, METRICS, UndeclaredMetricLabelError } from "../src/observability/metrics.js";
import { measureExchangeRateAges } from "../src/pricing/refreshRates.js";
import { createMemorySearchIndex } from "../src/search/adapters/memory.js";
import { withSearchMetrics } from "../src/search/metrics.js";
import { SearchUnavailableError } from "../src/search/ports.js";
import { withSearchTimeout } from "../src/search/timeout.js";

vi.mock("../src/auth/verifyIdToken.js", () => ({
  verifyIdToken: vi.fn().mockResolvedValue({ uid: "metrics-test-user" }),
}));

const { createApp } = await import("../src/app.js");

// Collects on demand: the in-memory stand-in for the 60 s OTLP export.
class TestReader extends MetricReader {
  async onForceFlush() {}
  async onShutdown() {}
}

const reader = new TestReader();

// Every point of a metric, as { attributes, value } (a histogram's value is
// its count).
const pointsOf = async (name) => {
  const { resourceMetrics } = await reader.collect();
  return resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === name)
    .flatMap((metric) => metric.dataPoints)
    .map((point) => ({
      attributes: point.attributes,
      value: typeof point.value === "number" ? point.value : point.value.count,
    }));
};

beforeAll(() => {
  otelMetrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
});

afterAll(() => {
  otelMetrics.disable();
});

describe("metrics", () => {
  it("records each GraphQL operation with its name, type and error code, and nothing else", async () => {
    const { app, httpServer } = await createApp();
    try {
      await request(app)
        .post("/graphql")
        .send({
          operationName: "MetricsProducts",
          query: "query MetricsProducts($first: Int) { products(first: $first) { edges { node { id } } } }",
          variables: { first: 1 },
        });
      await request(app).post("/graphql").send({ query: "query MetricsBroken { noSuchField }" });
    } finally {
      httpServer.close();
    }

    const points = await pointsOf("graphql.operation.duration");
    expect(points).toContainEqual({
      attributes: { operation: "MetricsProducts", type: "query", error_code: "none" },
      value: 1,
    });
    expect(points).toContainEqual({
      attributes: { operation: "MetricsBroken", type: "query", error_code: "GRAPHQL_VALIDATION_FAILED" },
      value: 1,
    });
    // Only the declared labels: never a variable, a user or a request id.
    for (const { attributes } of points) {
      expect(Object.keys(attributes).sort()).toEqual(["error_code", "operation", "type"]);
    }
  });

  it("records each search call with its engine and outcome", async () => {
    const memory = createMemorySearchIndex();
    const index = withSearchMetrics(withSearchTimeout(memory, 1000));
    await index.search({ text: "" });

    const failing = withSearchMetrics(
      withSearchTimeout({ ...memory, search: () => Promise.reject(new SearchUnavailableError("memory")) }, 1000)
    );
    await expect(failing.search({ text: "" })).rejects.toThrow(SearchUnavailableError);

    const slow = withSearchMetrics(withSearchTimeout({ ...memory, search: () => new Promise(() => {}) }, 10));
    await expect(slow.search({ text: "" })).rejects.toThrow(SearchUnavailableError);

    const points = await pointsOf("search.request.duration");
    for (const outcome of ["ok", "error", "timeout"]) {
      expect(points).toContainEqual({ attributes: { engine: "memory", outcome }, value: expect.any(Number) });
    }
  });

  it("measures the inventory queue by status", async () => {
    await measureInventoryQueue();
    const points = await pointsOf("inventory.tasks");
    expect(points.map((point) => point.attributes.status).sort()).toEqual(["FAILED", "PENDING"]);
    for (const { value } of points) expect(value).toBeGreaterThanOrEqual(0);
  });

  it("measures how old each exchange rate is", async () => {
    const now = new Date("2026-11-02T12:00:00Z");
    await writeExchangeRates([
      {
        from: "XBA",
        to: "MXN",
        rate: 1,
        asOf: "2026-11-02",
        fetchedAt: new Date(now.getTime() - 3_600_000),
        source: "test",
      },
    ]);
    try {
      await measureExchangeRateAges({ now });
      expect(await pointsOf("pricing.exchange_rate.age")).toContainEqual({
        attributes: { pair: "XBA_MXN" },
        value: 3600,
      });
    } finally {
      await db.collection("exchangeRates").doc("XBA_MXN").delete();
    }
  });

  it("rejects a label the metric doesn't declare", () => {
    expect(() => metrics.gauge("inventory.tasks", 1, { orderId: "order-1" })).toThrow(UndeclaredMetricLabelError);
    expect(() => metrics.record("search.request.duration", 0.1, { query: "red shoes" })).toThrow(
      UndeclaredMetricLabelError
    );
  });

  it("declares only labels with few values", () => {
    const unbounded = /id$|user|order|product|query|text|email/i;
    for (const [name, definition] of Object.entries(METRICS)) {
      for (const label of definition.labels) expect(label, `${name}: ${label}`).not.toMatch(unbounded);
    }
  });

  it("bounds a label that comes from the client", () => {
    const label = boundedLabel(2);
    expect(label("First")).toBe("First");
    expect(label("Second")).toBe("Second");
    expect(label("First")).toBe("First");
    // Past the limit, and anything that isn't a plain name.
    expect(label("Third")).toBe("other");
    expect(boundedLabel(5)("drop table; --")).toBe("other");
    expect(boundedLabel(5)("x".repeat(65))).toBe("other");
  });
});

describe("metrics of a job run", () => {
  it("are sent when the job exits, without waiting for the 60 s export", async () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--import", "./tests/helpers/tracingProbe.js", "src/jobs/processInventory.ts"],
      { env: { ...process.env, CLOUD_RUN_JOB: "process-inventory" }, stdio: ["ignore", "pipe", "pipe"] }
    );
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(...String(chunk).split("\n").filter(Boolean)));
    const [code] = await once(child, "exit");

    expect(code).toBe(0);
    // Printed by tests/helpers/tracingProbe.js.
    const points = stderr.filter((line) => line.startsWith("METRIC ")).map((line) => JSON.parse(line.slice(7)));
    expect(points).toContainEqual(
      expect.objectContaining({
        name: "inventory.tasks",
        attributes: { status: "PENDING" },
        service: "process-inventory",
        // A job's runs share one instance, so they extend the same series.
        instance: "process-inventory",
      })
    );
  }, 30000);
});
