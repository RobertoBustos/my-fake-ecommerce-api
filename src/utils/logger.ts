import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { formatEntry } from "../observability/formats/gcp.js";
import type { TraceContext } from "../observability/traceContext.js";

// Holds per-request data (the request ID and its trace) so any log call made
// while handling a request includes it, without threading it through every call.
export const requestContext = new AsyncLocalStorage<{ requestId: string; trace?: TraceContext }>();

// One JSON object per line: Cloud Logging parses it and maps `severity` to
// the log level, so in production entries can be filtered by requestId.
type Severity = "INFO" | "WARNING" | "ERROR";
export type LogFields = Record<string, unknown>;

export interface LogRecord {
  severity: Severity;
  message: string;
  time: string;
  requestId?: string;
  fields: LogFields;
  trace?: TraceContext;
  service: { name: string; version: string };
  // false keeps an ERROR line out of error reports (Error Reporting): for a
  // line that summarizes an error already logged on its own.
  report: boolean;
}

export interface LogOptions {
  report?: boolean;
}

// Read at runtime instead of imported: package.json sits outside rootDir, and
// both src/utils and dist/utils are two levels below it.
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};
const service = { name: pkg.name, version: pkg.version };

// Each job names itself, so its errors are grouped apart from the API's.
export const setLogService = (name: string) => {
  service.name = name;
};

const write = (severity: Severity, message: string, fields: LogFields = {}, { report = true }: LogOptions = {}) => {
  const store = requestContext.getStore();
  const entry = formatEntry({
    severity,
    message,
    time: new Date().toISOString(),
    requestId: store?.requestId,
    fields,
    trace: store?.trace,
    service,
    report,
  });
  const stream = severity === "ERROR" ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(entry)}\n`);
};

export const logger = {
  info: (message: string, fields?: LogFields) => write("INFO", message, fields),
  warn: (message: string, fields?: LogFields) => write("WARNING", message, fields),
  error: (message: string, fields?: LogFields, options?: LogOptions) => write("ERROR", message, fields, options),
};
