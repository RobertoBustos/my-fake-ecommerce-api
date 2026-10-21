import { appendFileSync, existsSync, readFileSync } from "node:fs";

// Writes the e2e workflow's job summary: how many tests passed, failed and
// were skipped (from Vitest's JSON report), and the X-Request-Id of every
// request a failed test sent (from the file e2e/setup.ts fills in), to find
// them in Cloud Logging.
// Usage: tsx e2e/summary.ts <vitest-json-report> <failures-file>

interface VitestReport {
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTotalTests: number;
}

interface Failure {
  test: string;
  requests: { label: string; requestId: string | null; status: number }[];
}

const [reportPath, failuresPath] = process.argv.slice(2);
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

const lines: string[] = ["## e2e suite", ""];
if (reportPath && existsSync(reportPath)) {
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as VitestReport;
  lines.push(
    "| Passed | Failed | Skipped | Total |",
    "| ---: | ---: | ---: | ---: |",
    `| ${report.numPassedTests} | ${report.numFailedTests} | ${report.numPendingTests} | ${report.numTotalTests} |`,
    ""
  );
} else {
  lines.push("The suite didn't produce a report: it failed before running any test. See the job log.", "");
}

const failures: Failure[] =
  failuresPath && existsSync(failuresPath)
    ? readFileSync(failuresPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Failure)
    : [];
if (failures.length > 0) {
  lines.push("### Requests of the failed tests", "");
  for (const { test, requests } of failures) {
    lines.push(`**${test}**`, "");
    if (requests.length === 0) lines.push("- No requests sent.");
    for (const { label, requestId, status } of requests) {
      lines.push(`- \`${label}\` -> HTTP ${status}, X-Request-Id \`${requestId ?? "none"}\``);
    }
    lines.push("");
  }
  lines.push("Find a request in Cloud Logging with `jsonPayload.requestId=\"<id>\"` (see the Runbook).", "");
}

const text = `${lines.join("\n")}\n`;
if (summaryPath) appendFileSync(summaryPath, text);
else process.stdout.write(text);
