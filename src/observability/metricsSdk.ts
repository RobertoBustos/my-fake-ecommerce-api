import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { exporterCredentials } from "./exporterAuth.ts";
import { onTelemetryShutdown } from "./lifecycle.ts";
import { logTelemetryDiagnostics, telemetryRequested, telemetryResource } from "./sdkCommon.ts";

// Exports the metrics declared in metrics.ts over OTLP every 60 s, to the same
// configurable destination as the traces. A job doesn't live 60 s: what it
// recorded is sent when it exits (runJob calls shutdownTelemetry).

export const EXPORT_INTERVAL_MS = 60_000;

export interface StartMetricsOptions {
  // Replaces the OTLP exporter; tests pass one that collects points.
  exporter?: PushMetricExporter;
  exportIntervalMs?: number;
}

let started = false;

export const startMetrics = ({ exporter, exportIntervalMs = EXPORT_INTERVAL_MS }: StartMetricsOptions = {}) => {
  if (started || (!exporter && !telemetryRequested("metrics"))) return false;
  started = true;
  logTelemetryDiagnostics();

  const provider = new MeterProvider({
    resource: telemetryResource(),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: exporter ?? new OTLPMetricExporter({ credentials: exporterCredentials() }),
        exportIntervalMillis: exportIntervalMs,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(provider);
  onTelemetryShutdown(() => provider.shutdown());
  return true;
};
