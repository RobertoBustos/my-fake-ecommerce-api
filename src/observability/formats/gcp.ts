import env from "../../config/env.js";
import type { LogRecord } from "../../utils/logger.js";

// Turns a log record into the JSON line Google Cloud Logging, Error Reporting
// and Cloud Trace understand. Every Google-specific field is written here and
// nowhere else, so moving to another provider means replacing this file.

const TRACE = "logging.googleapis.com/trace";
const SPAN_ID = "logging.googleapis.com/spanId";
const TRACE_SAMPLED = "logging.googleapis.com/trace_sampled";
// Makes Error Reporting take an ERROR line that has no stack trace.
const REPORTED_ERROR_EVENT =
  "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent";

// Trace ids are tied to a project. Cloud Run doesn't set GOOGLE_CLOUD_PROJECT,
// and the deploy sets only FIRESTORE_PROJECT_ID, which is the same project.
const projectId = () => env.GOOGLE_CLOUD_PROJECT || env.FIRESTORE_PROJECT_ID;

export const formatEntry = ({ severity, message, time, requestId, fields, trace, service }: LogRecord) => {
  // Error Reporting reads the stack from stack_trace; callers keep passing
  // `stack`, as before.
  const { stack, ...rest } = fields;
  const entry: Record<string, unknown> = { severity, message, time, requestId, ...rest };
  if (stack !== undefined) entry.stack_trace = stack;

  if (severity === "ERROR") {
    // Groups errors by service and shows the version that raised them.
    entry.serviceContext = { service: service.name, version: service.version };
    if (entry.stack_trace === undefined) entry["@type"] = REPORTED_ERROR_EVENT;
  }

  const project = projectId();
  if (trace && project) {
    entry[TRACE] = `projects/${project}/traces/${trace.traceId}`;
    if (trace.spanId) entry[SPAN_ID] = trace.spanId;
    if (trace.sampled !== undefined) entry[TRACE_SAMPLED] = trace.sampled;
  }
  return entry;
};
