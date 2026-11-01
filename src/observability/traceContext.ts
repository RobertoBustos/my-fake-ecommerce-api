// The trace a request belongs to, read from the headers Cloud Run's front end
// adds to every request. Clients can send these headers too, so only ids in
// the exact expected shape are kept; anything else is ignored.
export interface TraceContext {
  traceId: string;
  spanId?: string;
  sampled?: boolean;
}

// W3C Trace Context: version-traceId-parentId-flags, lowercase hex.
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
// Google's older header: TRACE_ID/SPAN_ID;o=OPTIONS, the span id in decimal.
const CLOUD_TRACE = /^([0-9a-f]{32})(?:\/(\d{1,20}))?(?:;o=([01]))?$/;

const ALL_ZEROS = /^0+$/;
const MAX_SPAN_ID = (1n << 64n) - 1n;

const fromTraceparent = (header: string): TraceContext | undefined => {
  const match = TRACEPARENT.exec(header.trim());
  if (!match) return undefined;
  const [, version, traceId, spanId, flags] = match;
  if (version === "ff" || ALL_ZEROS.test(traceId) || ALL_ZEROS.test(spanId)) return undefined;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 1) === 1 };
};

const fromCloudTrace = (header: string): TraceContext | undefined => {
  const match = CLOUD_TRACE.exec(header.trim().toLowerCase());
  if (!match) return undefined;
  const [, traceId, decimalSpanId, options] = match;
  if (ALL_ZEROS.test(traceId)) return undefined;
  const context: TraceContext = { traceId };
  if (decimalSpanId) {
    const span = BigInt(decimalSpanId);
    // Logging expects the span id as 16 hex digits, like traceparent carries it.
    if (span > 0n && span <= MAX_SPAN_ID) context.spanId = span.toString(16).padStart(16, "0");
  }
  if (options !== undefined) context.sampled = options === "1";
  return context;
};

// traceparent wins when both are present: it's the standard, and the one
// OpenTelemetry reads.
export const parseTraceContext = (
  traceparent: string | undefined,
  cloudTraceContext: string | undefined
): TraceContext | undefined =>
  (traceparent ? fromTraceparent(traceparent) : undefined) ??
  (cloudTraceContext ? fromCloudTrace(cloudTraceContext) : undefined);
