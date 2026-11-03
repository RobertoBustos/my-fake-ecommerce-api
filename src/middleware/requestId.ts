import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { parseTraceContext } from "#src/observability/traceContext.js";
import { requestContext } from "#src/utils/logger.js";

// An incoming X-Request-Id is reused only if it's safe to write to the logs;
// anything else gets a fresh UUID.
const SAFE_ID = /^[\w-]{1,128}$/;

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get("x-request-id");
  const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  // Echoed back so a client can quote it when reporting a problem.
  res.set("X-Request-Id", id);
  // Cloud Run's front end sends the trace headers, so every log line of the
  // request opens from its trace.
  const trace = parseTraceContext(req.get("traceparent"), req.get("x-cloud-trace-context"));
  requestContext.run({ requestId: id, trace }, next);
};
