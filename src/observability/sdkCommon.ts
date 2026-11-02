import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { diag, DiagLogLevel } from "@opentelemetry/api";
import { detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import { logger } from "../utils/logger.js";

// What the trace and metric SDKs share: when they start, who they say they
// are, and where their own errors go.

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

// A signal is on when there is somewhere to send it: its own endpoint
// (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, ..._METRICS_ENDPOINT) or the shared
// one. Local runs and the tests set neither. OTEL_SDK_DISABLED=true turns
// everything off even then.
export const telemetryRequested = (signal: "traces" | "metrics", env: NodeJS.ProcessEnv = process.env) =>
  env.OTEL_SDK_DISABLED !== "true" &&
  Boolean(env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`] || env.OTEL_EXPORTER_OTLP_ENDPOINT);

// Who is sending. OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES win.
// Otherwise a job is named like its Cloud Run job, so its traces and metrics
// are told apart from the API's. Metrics also need an instance: a job runs
// one execution at a time, so its name is stable across runs; each API
// instance gets its own id, so two instances never write the same series.
// Cloud Monitoring also needs the region (cloud.region in
// OTEL_RESOURCE_ATTRIBUTES). Built once, so traces and metrics name the same
// instance.
let resource: ReturnType<typeof resourceFromAttributes> | undefined;

export const telemetryResource = (env: NodeJS.ProcessEnv = process.env) =>
  (resource ??= resourceFromAttributes({
    "service.name": env.CLOUD_RUN_JOB || pkg.name,
    "service.version": pkg.version,
    "service.instance.id": env.CLOUD_RUN_JOB || randomUUID(),
  }).merge(detectResources({ detectors: [envDetector] })));

// The SDK's own warnings and errors (an export Google rejected, a point that
// couldn't be sent) go to the logs as WARNING; otherwise a broken exporter
// would fail silently and the data would just stop arriving.
const diagnostics = (message: string, ...args: unknown[]) =>
  logger.warn(`OpenTelemetry: ${message}`, {
    details: args.map((arg) => (arg instanceof Error ? arg.message : String(arg))),
  });

let diagnosticsOn = false;

export const logTelemetryDiagnostics = () => {
  if (diagnosticsOn) return;
  diagnosticsOn = true;
  diag.setLogger(
    { error: diagnostics, warn: diagnostics, info: () => {}, debug: () => {}, verbose: () => {} },
    DiagLogLevel.WARN
  );
};
