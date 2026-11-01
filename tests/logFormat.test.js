import { readFileSync } from "node:fs";
import { describe, it, expect, afterEach, vi } from "vitest";
import { formatEntry } from "../src/observability/formats/gcp.js";
import { parseTraceContext } from "../src/observability/traceContext.js";
import { logger, requestContext, setLogService } from "../src/utils/logger.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

const record = (overrides = {}) => ({
  severity: "INFO",
  message: "Something happened",
  time: "2026-10-27T15:00:00.000Z",
  requestId: "req-1",
  fields: {},
  service: { name: "my-fake-ecommerce-api", version: "1.6.0" },
  ...overrides,
});

// Captures the JSON lines the logger writes to one stream.
const capture = (stream) => {
  const lines = [];
  vi.spyOn(process[stream], "write").mockImplementation((chunk) => {
    lines.push(...String(chunk).split("\n").filter(Boolean));
    return true;
  });
  return () => lines.map((line) => JSON.parse(line));
};

describe("Google Cloud log format", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes the stack as stack_trace, never as stack", () => {
    const entry = formatEntry(
      record({ severity: "ERROR", message: "Boom", fields: { stack: "Error: Boom\n    at x (y.js:1:1)", path: "products" } })
    );
    expect(entry.stack_trace).toContain("Error: Boom");
    expect(entry).not.toHaveProperty("stack");
    expect(entry.path).toBe("products");
  });

  it("adds serviceContext to errors so Error Reporting groups them", () => {
    const entry = formatEntry(record({ severity: "ERROR", fields: { stack: "Error: x" } }));
    expect(entry.serviceContext).toEqual({ service: "my-fake-ecommerce-api", version: "1.6.0" });
    expect(entry).not.toHaveProperty("@type");
  });

  it("marks an error without a stack as a reported error event", () => {
    const entry = formatEntry(record({ severity: "ERROR", message: "Payment not applied to its order" }));
    expect(entry["@type"]).toBe(
      "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent"
    );
    expect(entry.serviceContext.service).toBe("my-fake-ecommerce-api");
  });

  it("leaves Error Reporting fields out of INFO and WARNING lines", () => {
    for (const severity of ["INFO", "WARNING"]) {
      const entry = formatEntry(record({ severity }));
      expect(entry).not.toHaveProperty("serviceContext");
      expect(entry).not.toHaveProperty("@type");
    }
  });

  it("links the line to its trace in the project", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    vi.stubEnv("FIRESTORE_PROJECT_ID", "my-project");
    const entry = formatEntry(record({ trace: { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true } }));
    expect(entry).toMatchObject({
      "logging.googleapis.com/trace": `projects/my-project/traces/${TRACE_ID}`,
      "logging.googleapis.com/spanId": SPAN_ID,
      "logging.googleapis.com/trace_sampled": true,
    });
  });

  it("prefers GOOGLE_CLOUD_PROJECT for the trace's project", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "gcp-project");
    vi.stubEnv("FIRESTORE_PROJECT_ID", "firestore-project");
    const entry = formatEntry(record({ trace: { traceId: TRACE_ID } }));
    expect(entry["logging.googleapis.com/trace"]).toBe(`projects/gcp-project/traces/${TRACE_ID}`);
    expect(entry).not.toHaveProperty("logging.googleapis.com/spanId");
  });

  it("writes no trace fields without a trace or without a project", () => {
    vi.stubEnv("FIRESTORE_PROJECT_ID", "my-project");
    expect(formatEntry(record())).not.toHaveProperty("logging.googleapis.com/trace");

    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    vi.stubEnv("FIRESTORE_PROJECT_ID", "");
    expect(formatEntry(record({ trace: { traceId: TRACE_ID } }))).not.toHaveProperty(
      "logging.googleapis.com/trace"
    );
  });
});

describe("trace headers", () => {
  it("reads a W3C traceparent", () => {
    expect(parseTraceContext(`00-${TRACE_ID}-${SPAN_ID}-01`, undefined)).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      sampled: true,
    });
    expect(parseTraceContext(`00-${TRACE_ID}-${SPAN_ID}-00`, undefined).sampled).toBe(false);
  });

  it("reads X-Cloud-Trace-Context and turns its decimal span id into hex", () => {
    expect(parseTraceContext(undefined, `${TRACE_ID}/67667974448284343;o=1`)).toEqual({
      traceId: TRACE_ID,
      spanId: "00f067aa0ba902b7",
      sampled: true,
    });
    expect(parseTraceContext(undefined, TRACE_ID.toUpperCase())).toEqual({ traceId: TRACE_ID });
  });

  it("prefers traceparent when both headers come", () => {
    const other = "a".repeat(32);
    expect(parseTraceContext(`00-${TRACE_ID}-${SPAN_ID}-01`, `${other}/1;o=1`).traceId).toBe(TRACE_ID);
  });

  it("falls back to X-Cloud-Trace-Context when traceparent is invalid", () => {
    const other = "a".repeat(32);
    expect(parseTraceContext("garbage", `${other}/1`).traceId).toBe(other);
  });

  it("ignores ids that aren't in the expected shape", () => {
    const invalid = [
      ["00-" + "0".repeat(32) + `-${SPAN_ID}-01`, undefined],
      [`00-${TRACE_ID}-${"0".repeat(16)}-01`, undefined],
      [`ff-${TRACE_ID}-${SPAN_ID}-01`, undefined],
      [`00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`, undefined],
      [`00-${TRACE_ID}-${SPAN_ID}-01","severity":"INFO`, undefined],
      [undefined, "not-a-trace"],
      [undefined, `${"0".repeat(32)}/1`],
      [undefined, undefined],
    ];
    for (const [traceparent, cloud] of invalid) {
      expect(parseTraceContext(traceparent, cloud)).toBeUndefined();
    }
  });

  it("drops a span id that doesn't fit in 64 bits", () => {
    expect(parseTraceContext(undefined, `${TRACE_ID}/18446744073709551616`)).toEqual({ traceId: TRACE_ID });
    expect(parseTraceContext(undefined, `${TRACE_ID}/0`)).toEqual({ traceId: TRACE_ID });
  });
});

describe("logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setLogService(pkg.name);
  });

  it("names the service and version from package.json", () => {
    const read = capture("stderr");
    logger.error("Boom", { stack: "Error: Boom" });
    expect(read()[0].serviceContext).toEqual({ service: pkg.name, version: pkg.version });
  });

  it("uses the name a job sets for itself", () => {
    const read = capture("stderr");
    setLogService("sync-catalog");
    logger.error("Catalog sync job failed", { error: "down" });
    expect(read()[0].serviceContext.service).toBe("sync-catalog");
  });

  it("writes the trace of the request it runs in", () => {
    vi.stubEnv("FIRESTORE_PROJECT_ID", "my-project");
    const read = capture("stdout");
    requestContext.run({ requestId: "req-9", trace: { traceId: TRACE_ID, spanId: SPAN_ID } }, () =>
      logger.info("Inside a request")
    );
    logger.info("Outside a request");
    const [inside, outside] = read();
    expect(inside).toMatchObject({
      requestId: "req-9",
      "logging.googleapis.com/trace": `projects/my-project/traces/${TRACE_ID}`,
      "logging.googleapis.com/spanId": SPAN_ID,
    });
    expect(outside).not.toHaveProperty("logging.googleapis.com/trace");
  });
});
