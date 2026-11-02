import { startTracing } from "../../src/observability/tracing.ts";

// Loaded with `node --import` by tracing tests: starts tracing with an
// exporter that prints every finished span as one "SPAN {json}" line on
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
