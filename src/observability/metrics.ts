import { metrics as otelMetrics, type Attributes, type MeterProvider } from "@opentelemetry/api";

// Numbers over time for alerts and the dashboard, through the OpenTelemetry
// API only (the SDK that exports them lives in metricsSdk.ts). With
// telemetry off every call is a no-op.
//
// Every metric is declared here with the only labels it may carry. Each
// distinct combination of label values is a time series, and each series
// costs, so a label is something with few values (an operation, an error
// code, a source, an engine), never an order, user or product id or the
// search text. Recording a label that isn't declared throws: that's a bug at
// the call site, not something to send.

interface Definition {
  kind: "histogram" | "gauge";
  description: string;
  unit: string;
  labels: readonly string[];
  // Histogram buckets, in the metric's unit.
  buckets?: number[];
}

// Seconds, from 5 ms to 10 s: a GraphQL operation or a search call. 0.5 and
// 2 are the latency SLOs' limits (ops/monitoring/services/), which count
// whole buckets: a limit between two bounds can't be measured exactly.
const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10];

export const METRICS = {
  // RED per operation: the count is the rate, error_code="none" splits
  // errors from successes, and the buckets give the duration.
  "graphql.operation.duration": {
    kind: "histogram",
    description: "Duration of each GraphQL operation, by operation, type and the error code it answered",
    unit: "s",
    labels: ["operation", "type", "error_code"],
    buckets: LATENCY_BUCKETS,
  },
  // The engine's share of searchProducts, apart from reading the catalog.
  "search.request.duration": {
    kind: "histogram",
    description: "Duration of each call to the search engine, by engine and outcome (ok, error, timeout)",
    unit: "s",
    labels: ["engine", "outcome"],
    buckets: LATENCY_BUCKETS,
  },
  "inventory.tasks": {
    kind: "gauge",
    description: "Inventory queue tasks by status, measured on each process-inventory run",
    unit: "{task}",
    labels: ["status"],
  },
  "catalog.source.staleness": {
    kind: "gauge",
    description: "Seconds since each catalog source last synced successfully, measured on each sync-catalog run",
    unit: "s",
    labels: ["source"],
  },
  "search.index.failed_writes": {
    kind: "gauge",
    description: "Search index writes that failed in the last sync-catalog run",
    unit: "{write}",
    labels: ["engine"],
  },
  "pricing.exchange_rate.age": {
    kind: "gauge",
    description: "Seconds since each exchange rate was last confirmed, measured on each sync-catalog run",
    unit: "s",
    labels: ["pair"],
  },
} as const satisfies Record<string, Definition>;

type Metrics = typeof METRICS;
type MetricName<Kind extends Definition["kind"]> = {
  [Name in keyof Metrics]: Metrics[Name]["kind"] extends Kind ? Name : never;
}[keyof Metrics];
type Labels<Name extends keyof Metrics> = Partial<Record<Metrics[Name]["labels"][number], string>>;

export class UndeclaredMetricLabelError extends Error {
  constructor(name: string, label: string) {
    super(`Metric ${name} has no label "${label}"; declare it in METRICS or leave it out`);
    this.name = "UndeclaredMetricLabelError";
  }
}

const METER = "my-fake-ecommerce-api";

// Instruments are built on first use against the meter provider of that
// moment, and again if it changes (tests install their own).
let instrumentsOf: MeterProvider | undefined;
const instruments = new Map<string, { record(value: number, attributes: Attributes): void }>();

const instrument = (name: keyof Metrics) => {
  const provider = otelMetrics.getMeterProvider();
  if (provider !== instrumentsOf) {
    instruments.clear();
    instrumentsOf = provider;
  }
  let built = instruments.get(name);
  if (!built) {
    const definition: Definition = METRICS[name];
    const meter = provider.getMeter(METER);
    const options = { description: definition.description, unit: definition.unit };
    built =
      definition.kind === "histogram"
        ? meter.createHistogram(name, { ...options, advice: { explicitBucketBoundaries: definition.buckets } })
        : meter.createGauge(name, options);
    instruments.set(name, built);
  }
  return built;
};

const checked = (name: keyof Metrics, labels: Record<string, string | undefined>): Attributes => {
  const allowed: readonly string[] = METRICS[name].labels;
  const attributes: Attributes = {};
  for (const [label, value] of Object.entries(labels)) {
    if (!allowed.includes(label)) throw new UndeclaredMetricLabelError(name, label);
    if (value !== undefined) attributes[label] = value;
  }
  return attributes;
};

// No counters: requests and errors per operation are the histogram's count,
// which Cloud Monitoring splits by error_code.
export const metrics = {
  // One observation of a histogram, such as a duration.
  record: <Name extends MetricName<"histogram">>(name: Name, value: number, labels: Labels<Name> = {}) =>
    instrument(name).record(value, checked(name, labels)),
  // The current value of a gauge; the last one set before an export wins.
  gauge: <Name extends MetricName<"gauge">>(name: Name, value: number, labels: Labels<Name> = {}) =>
    instrument(name).record(value, checked(name, labels)),
};

// Keeps a label that comes from a client (a GraphQL operation name) from
// growing without bound: the first `max` distinct values that look like a
// name are kept, and anything else is reported as "other".
export const boundedLabel = (max: number) => {
  const seen = new Set<string>();
  return (value: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value)) return "other";
    if (seen.has(value)) return value;
    if (seen.size >= max) return "other";
    seen.add(value);
    return value;
  };
};
