// What the telemetry SDKs (traces, metrics) need done before the process
// exits: send what they still hold. Each SDK registers its own shutdown when
// it starts; with telemetry off there is nothing to do.

const shutdowns: (() => Promise<void>)[] = [];

export const onTelemetryShutdown = (shutdown: () => Promise<void>) => {
  shutdowns.push(shutdown);
};

// Sends the spans and metric points still buffered and stops. Called on
// shutdown and at the end of a job; resolves at once when telemetry is off.
export const shutdownTelemetry = async () => {
  const pending = shutdowns.splice(0);
  await Promise.all(pending.map((shutdown) => shutdown()));
};
