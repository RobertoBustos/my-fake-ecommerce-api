import { register } from "node:module";
import { readFileSync } from "node:fs";
import { diag, DiagLogLevel, trace, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { GraphQLInstrumentation } from "@opentelemetry/instrumentation-graphql";
import { GrpcInstrumentation } from "@opentelemetry/instrumentation-grpc";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  SamplingDecision,
  type Sampler,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-node";
import { exporterCredentials } from "./exporterAuth.js";
import { logger } from "../utils/logger.js";
import { requestSpanNames, setTracingShutdown } from "./spans.js";

// Traces with OpenTelemetry: every request and job run becomes a trace whose
// spans show where the time went (GraphQL, Firestore over gRPC, Stripe and
// Algolia over HTTPS). Spans leave over OTLP; where they go is configuration
// (the standard OTEL_EXPORTER_OTLP_* variables), never code.
//
// Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set, so local runs and the tests
// trace nothing. OTEL_SDK_DISABLED=true turns it off even then.

// Requests answered without looking at the body or the database: tracing them
// would only fill the trace list (the uptime check calls every minute).
const UNTRACED_PATHS = new Set(["/healthcheck"]);

// The schema is parsed once at startup, outside any request: each parse would
// be a trace of one span that says nothing ("graphql.parseSchema"). The span
// is only renamed after it starts, so it's dropped by its first name: a
// GraphQL parse with no parent, which a request's parse never is.
const STARTUP_SPANS = new Set(["graphql.parse"]);

// Every trace while traffic is low. Cloud Run's front end starts most requests
// as "not sampled", so a parent that wasn't sampled is recorded too;
// otherwise almost nothing would be.
const everyRequest = new ParentBasedSampler({
  root: new AlwaysOnSampler(),
  remoteParentNotSampled: new AlwaysOnSampler(),
});

const sampler: Sampler = {
  shouldSample: (parentContext, traceId, spanName, ...rest) =>
    !trace.getSpan(parentContext) && STARTUP_SPANS.has(spanName)
      ? { decision: SamplingDecision.NOT_RECORD }
      : everyRequest.shouldSample(parentContext, traceId, spanName, ...rest),
  toString: () => `WithoutStartupSpans{${everyRequest.toString()}}`,
};

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

export const tracingRequested = (env: NodeJS.ProcessEnv = process.env) =>
  env.OTEL_SDK_DISABLED !== "true" &&
  Boolean(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT);

export interface StartTracingOptions {
  // Replaces the OTLP exporter; tests pass one that collects spans.
  exporter?: SpanExporter;
}

// The SDK's own warnings and errors (an export Google rejected, a span that
// couldn't be sent) go to the logs as WARNING; otherwise a broken exporter
// would fail silently and traces would just stop arriving.
const diagnostics = (message: string, ...args: unknown[]) =>
  logger.warn(`OpenTelemetry: ${message}`, {
    details: args.map((arg) => (arg instanceof Error ? arg.message : String(arg))),
  });

let started = false;

// Runs before the app is loaded (src/telemetry.ts, through `node --import`):
// instrumentation can only patch a library that hasn't been imported yet.
export const startTracing = ({ exporter }: StartTracingOptions = {}) => {
  if (started || (!exporter && !tracingRequested())) return false;
  started = true;
  diag.setLogger(
    { error: diagnostics, warn: diagnostics, info: () => {}, debug: () => {}, verbose: () => {} },
    DiagLogLevel.WARN
  );

  // The app is ESM: this hook lets the instrumentations patch modules loaded
  // with `import`, not only with `require`.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  const provider = new NodeTracerProvider({
    // OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES win. Otherwise a job is
    // named like its Cloud Run job, so its traces are told apart from the API's.
    resource: resourceFromAttributes({
      "service.name": process.env.CLOUD_RUN_JOB || pkg.name,
      "service.version": pkg.version,
    }).merge(detectResources({ detectors: [envDetector] })),
    sampler,
    spanProcessors: [
      new BatchSpanProcessor(exporter ?? new OTLPTraceExporter({ credentials: exporterCredentials() })),
    ],
  });
  provider.register();
  setTracingShutdown(() => provider.shutdown());

  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => UNTRACED_PATHS.has((request.url ?? "").split("?")[0]),
        // Runs after the instrumentation names the span after its route
        // ("POST /graphql"), so the operation's name is the one that stays.
        applyCustomAttributesOnSpan: (span) => {
          const name = requestSpanNames.get(span as Span);
          if (name) span.updateName(name);
        },
      }),
      new ExpressInstrumentation(),
      // Never the variables (updateOrder carries an address and a phone,
      // searchProducts the search text). The query text keeps no inline
      // values either: allowValues false replaces them with "*".
      new GraphQLInstrumentation({ allowValues: false, mergeItems: true, ignoreTrivialResolveSpans: true }),
      // Firestore talks gRPC.
      new GrpcInstrumentation(),
      // The global fetch (exchange rates). Stripe and Algolia use node:http,
      // which HttpInstrumentation covers.
      new UndiciInstrumentation(),
    ],
  });
  return true;
};
