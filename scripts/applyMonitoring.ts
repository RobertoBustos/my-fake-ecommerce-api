import { parseArgs } from "node:util";
import { GoogleAuth } from "google-auth-library";
import {
  applyMonitoring,
  buildTestEntries,
  MonitoringApplyError,
  writeTestLogs,
  type MonitoringApi,
} from "./monitoring/apply.js";
import { loadMonitoringConfig } from "./monitoring/config.js";

// Applies ops/monitoring/ (notification channel, log-based metrics and alert
// policies) to a Google Cloud project. Idempotent: run it after changing any
// of those files. It talks to the APIs directly with your Application Default
// Credentials (`gcloud auth application-default login`), so it needs no .env:
//
//   npx tsx scripts/applyMonitoring.ts --project <id> --email <address> [--dry-run]
//   npx tsx scripts/applyMonitoring.ts --project <id> --test <policy-id>
//
// --test writes that policy's test log, so it fires and its email arrives.
// A policy on a log-based metric created in the same run is retried for up to
// 10 minutes, the time Google takes to make a new metric usable.
const { values } = parseArgs({
  options: {
    project: { type: "string" },
    email: { type: "string" },
    region: { type: "string", default: "us-central1" },
    "dry-run": { type: "boolean", default: false },
    test: { type: "string" },
  },
});

if (!values.project) {
  console.error("Pass the Google Cloud project: --project <id>");
  process.exit(1);
}

const config = loadMonitoringConfig(new URL("../ops/monitoring/", import.meta.url).pathname);
const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
const api: MonitoringApi = {
  request: async (method, url, body) => (await client.request({ method, url, data: body })).data as never,
};

if (values.test) {
  const body = buildTestEntries(config, values.test, values.project, values.region);
  await writeTestLogs(api, body);
  console.log(`Wrote ${body.entries.length} test log(s) for ${values.test}; the alert email should arrive in a few minutes`);
} else {
  try {
    await applyMonitoring({
      config,
      api,
      project: values.project,
      email: values.email ?? process.env.ALERT_EMAIL ?? "",
      dryRun: values["dry-run"],
    });
  } catch (err) {
    // Every policy that could be applied was; list the rest and fail.
    if (!(err instanceof MonitoringApplyError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}
