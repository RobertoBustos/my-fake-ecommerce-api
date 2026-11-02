import { register } from "node:module";
import { trace, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { GraphQLInstrumentation } from "@opentelemetry/instrumentation-graphql";
import { GrpcInstrumentation } from "@opentelemetry/instrumentation-grpc";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
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
import { onTelemetryShutdown } from "./lifecycle.js";
import { logTelemetryDiagnostics, telemetryRequested, telemetryResource } from "./sdkCommon.js";
import { requestSpanNames } from "./spans.js";

// Traces with OpenTelemetry: every request and job run becomes a trace whose
// spans show where the time went (GraphQL, Firestore over gRPC, Stripe and
// Algolia over HTTPS). Spans leave over OTLP; where they go is configuration
// (the standard OTEL_EXPORTER_OTLP_* variables), never code.
//
// Off unless an OTLP endpoint is set (sdkCommon.ts), so local runs and the
// tests trace nothing.

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

export interface StartTracingOptions {
  // Replaces the OTLP exporter; tests pass one that collects spans.
  exporter?: SpanExporter;
}

let started = false;

// Runs before the app is loaded (src/telemetry.ts, through `node --import`):
// instrumentation can only patch a library that hasn't been imported yet.
export const startTracing = ({ exporter }: StartTracingOptions = {}) => {
  if (started || (!exporter && !telemetryRequested("traces"))) return false;
  started = true;
  logTelemetryDiagnostics();

  // The app is ESM: this hook lets the instrumentations patch modules loaded
  // with `import`, not only with `require`.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  const provider = new NodeTracerProvider({
    resource: telemetryResource(),
    sampler,
    spanProcessors: [
      new BatchSpanProcessor(exporter ?? new OTLPTraceExporter({ credentials: exporterCredentials() })),
    ],
  });
  provider.register();
  onTelemetryShutdown(() => provider.shutdown());

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
