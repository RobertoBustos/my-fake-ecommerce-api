import { startMetrics } from "../../src/observability/metricsSdk.ts";
import { startTracing } from "../../src/observability/tracing.ts";

// Loaded with `node --import` by tracing and metrics tests: starts tracing
// and metrics with exporters that print every finished span as a
// "SPAN {json}" line and every metric point as a "METRIC {json}" line on
// stderr, so the test can read them from the child process.
startTracing({
  exporter: {
    export(spans, done) {
      for (const span of spans) {
        const { traceId, spanId } = span.spanContext();
        const line = {
          name: span.name,
          kind: span.kind,
          traceId,
          spanId,
          parentSpanId: span.parentSpanContext?.spanId,
          attributes: span.attributes,
          events: span.events.map((event) => event.name),
          service: span.resource.attributes["service.name"],
        };
        process.stderr.write(`SPAN ${JSON.stringify(line)}\n`);
      }
      done({ code: 0 });
    },
    shutdown: async () => {},
  },
});

startMetrics({
  exporter: {
    export(resourceMetrics, done) {
      for (const scope of resourceMetrics.scopeMetrics) {
        for (const metric of scope.metrics) {
          for (const point of metric.dataPoints) {
            const value = typeof point.value === "number" ? point.value : point.value.count;
            const line = {
              name: metric.descriptor.name,
              attributes: point.attributes,
              value,
              service: resourceMetrics.resource.attributes["service.name"],
              instance: resourceMetrics.resource.attributes["service.instance.id"],
            };
            process.stderr.write(`METRIC ${JSON.stringify(line)}\n`);
          }
        }
      }
      done({ code: 0 });
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  },
});
