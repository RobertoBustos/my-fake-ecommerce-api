import { startMetrics } from "./observability/metricsSdk.ts";
import { startTracing } from "./observability/tracing.ts";

// Loaded before the app or a job with `node --import ./dist/telemetry.js` (the
// Dockerfile sets it in NODE_OPTIONS, so the API and every Cloud Run job get
// it). It has to run first: instrumentation only patches libraries that
// haven't been loaded yet. Does nothing unless an OTLP endpoint is configured.
// Starts the traces and the metrics.
startTracing();
startMetrics();
