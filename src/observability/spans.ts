import { readFileSync } from "node:fs";
import { context, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { getRPCMetadata } from "@opentelemetry/core";

// What the app does with tracing, through the OpenTelemetry API only. With
// tracing off (local runs, tests) every call here is a no-op; the SDK itself
// lives in tracing.ts and is loaded only by src/telemetry.ts.

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

// The name the server span of a request should end with (see nameRequestSpan).
export const requestSpanNames = new WeakMap<Span, string>();

// Names the trace of the current request (its server span), so the trace list
// reads "graphql createOrderPayment" instead of "POST /graphql".
export const nameRequestSpan = (name: string) => {
  const span = getRPCMetadata(context.active())?.span;
  if (!span) return;
  requestSpanNames.set(span, name);
  span.updateName(name);
};

// Runs work inside a span of its own: the root of a job run, so every call it
// makes (and every log line it writes) lands in one trace.
export const withSpan = <T>(name: string, work: () => Promise<T>) =>
  trace.getTracer(pkg.name, pkg.version).startActiveSpan(name, async (span) => {
    try {
      return await work();
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });

let flush: (() => Promise<void>) | undefined;

// Set by tracing.ts when the SDK starts.
export const setTracingShutdown = (shutdown: () => Promise<void>) => {
  flush = shutdown;
};

// Sends the spans still buffered and stops tracing. Called on shutdown and at
// the end of a job; resolves at once when tracing is off.
export const shutdownTracing = async () => {
  const current = flush;
  flush = undefined;
  await current?.();
};
