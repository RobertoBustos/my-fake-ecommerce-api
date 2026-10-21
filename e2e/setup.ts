import { appendFileSync } from "node:fs";
import { beforeEach, expect } from "vitest";
import { requestLog } from "./helpers/graphql.js";

// Each test starts with an empty log of request ids, and a failed test
// prints them, so the failing request can be found in Cloud Logging. With
// E2E_FAILURES_FILE set (the e2e workflow does), each failure is also
// appended to that file as one JSON line, for the job summary.
beforeEach(({ onTestFailed }) => {
  requestLog.length = 0;
  const test = expect.getState().currentTestName ?? "unknown test";
  onTestFailed(() => {
    if (requestLog.length > 0) {
      const lines = requestLog.map(({ label, requestId, status }) => `  ${label} -> HTTP ${status}, X-Request-Id ${requestId}`);
      console.error(`Requests of the failed test:\n${lines.join("\n")}`);
    }
    const file = process.env.E2E_FAILURES_FILE;
    if (file) appendFileSync(file, `${JSON.stringify({ test, requests: requestLog })}\n`);
  });
});
