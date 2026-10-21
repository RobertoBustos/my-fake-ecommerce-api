import { beforeEach } from "vitest";
import { requestLog } from "./helpers/graphql.js";

// Each test starts with an empty log of request ids, and a failed test
// prints them, so the failing request can be found in Cloud Logging.
beforeEach(({ onTestFailed }) => {
  requestLog.length = 0;
  onTestFailed(() => {
    if (requestLog.length === 0) return;
    const lines = requestLog.map(({ label, requestId, status }) => `  ${label} -> HTTP ${status}, X-Request-Id ${requestId}`);
    console.error(`Requests of the failed test:\n${lines.join("\n")}`);
  });
});
