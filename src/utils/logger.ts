import { AsyncLocalStorage } from "node:async_hooks";

// Holds per-request data (the request ID) so any log call made while
// handling a request includes it, without threading it through every call.
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

// One JSON object per line: Cloud Logging parses it and maps `severity` to
// the log level, so in production entries can be filtered by requestId.
type Severity = "INFO" | "WARNING" | "ERROR";
export type LogFields = Record<string, unknown>;

const write = (severity: Severity, message: string, fields: LogFields = {}) => {
  const entry = {
    severity,
    message,
    time: new Date().toISOString(),
    requestId: requestContext.getStore()?.requestId,
    ...fields,
  };
  const stream = severity === "ERROR" ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(entry)}\n`);
};

export const logger = {
  info: (message: string, fields?: LogFields) => write("INFO", message, fields),
  warn: (message: string, fields?: LogFields) => write("WARNING", message, fields),
  error: (message: string, fields?: LogFields) => write("ERROR", message, fields),
};
