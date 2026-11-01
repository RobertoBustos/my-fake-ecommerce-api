import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import {
  loadMonitoringConfig,
  MonitoringConfigError,
  RUNBOOK_URL,
} from "../scripts/monitoring/config.js";
import { applyMonitoring, buildTestEntries, MonitoringApplyError } from "../scripts/monitoring/apply.js";

const ROOT = new URL("../ops/monitoring/", import.meta.url).pathname;

// A copy of ops/monitoring/ that a test can break on purpose.
const copies = [];
const copyConfig = () => {
  const dir = mkdtempSync(join(tmpdir(), "monitoring-"));
  cpSync(ROOT, dir, { recursive: true });
  copies.push(dir);
  return dir;
};
const edit = (dir, file, change) => {
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify(change(JSON.parse(readFileSync(path, "utf8"))), null, 2));
};
const errorsOf = (dir) => {
  try {
    loadMonitoringConfig(dir);
    return [];
  } catch (err) {
    if (!(err instanceof MonitoringConfigError)) throw err;
    return err.errors;
  }
};

// An in-memory stand-in for the Monitoring and Logging APIs.
const fakeApi = () => {
  const state = { channels: [], policies: [], metrics: {}, writes: [] };
  let next = 1;
  return {
    state,
    request: async (method, url, body) => {
      if (method !== "GET") state.writes.push({ method, url });
      if (method === "GET" && url.includes("/notificationChannels")) return { notificationChannels: state.channels };
      if (method === "GET" && url.includes("/alertPolicies")) return { alertPolicies: state.policies };
      if (method === "PUT" && url.includes("/metrics/")) {
        state.metrics[body.name] = body;
        return body;
      }
      if (method === "POST" && url.endsWith("/notificationChannels")) {
        const channel = { ...body, name: `projects/p/notificationChannels/${next++}` };
        state.channels.push(channel);
        return channel;
      }
      if (method === "POST" && url.endsWith("/alertPolicies")) {
        const policy = { ...body, name: `projects/p/alertPolicies/${next++}` };
        state.policies.push(policy);
        return policy;
      }
      if (method === "PATCH") {
        const list = url.includes("/notificationChannels/") ? state.channels : state.policies;
        const index = list.findIndex((item) => url.endsWith(item.name));
        list[index] = { ...body, name: list[index].name };
        return list[index];
      }
      throw new Error(`Unexpected ${method} ${url}`);
    },
  };
};

describe("ops/monitoring/ config", () => {
  afterEach(() => {
    copies.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it("is valid: every policy links to the Runbook and names known channels and metrics", () => {
    const config = loadMonitoringConfig(ROOT);
    expect(Object.keys(config.policies).sort()).toEqual([
      "algolia-usage",
      "exchange-rate-unavailable",
      "http-5xx",
      "inventory-task-failed",
      "payment-not-applied",
      "search-engine-down",
      "search-index-unsynced",
    ]);
    for (const { policy } of Object.values(config.policies)) {
      expect(policy.documentation.content).toContain(RUNBOOK_URL);
      expect(policy.notificationChannels).toEqual(["email"]);
    }
  });

  it("keeps the real email address out of the repo", () => {
    expect(loadMonitoringConfig(ROOT).channels.email.labels.email_address).toBe("${ALERT_EMAIL}");
  });

  it("has a test log for every policy that a log can fire", () => {
    const { policies } = loadMonitoringConfig(ROOT);
    const withoutTest = Object.keys(policies).filter((id) => !policies[id].test);
    // 5xx responses come from Cloud Run's own metric, not from a log.
    expect(withoutTest).toEqual(["http-5xx"]);
  });

  it("fires the threshold policies with their test logs", () => {
    const { policies } = loadMonitoringConfig(ROOT);
    for (const { policy, test } of Object.values(policies)) {
      const threshold = policy.conditions[0].conditionThreshold;
      if (threshold && test) expect(test.count).toBeGreaterThan(threshold.thresholdValue);
    }
  });

  it("rejects a policy without a Runbook link", () => {
    const dir = copyConfig();
    edit(dir, "policies/search-engine-down.json", (file) => {
      file.policy.documentation.content = "No link here";
      return file;
    });
    expect(errorsOf(dir)).toEqual([expect.stringContaining("policies/search-engine-down.json")]);
  });

  it("rejects unknown channels and metrics, and a log-match policy without a rate limit", () => {
    const dir = copyConfig();
    edit(dir, "policies/search-engine-down.json", (file) => {
      file.policy.notificationChannels = ["slack"];
      file.policy.conditions[0].conditionThreshold.filter = 'metric.type="logging.googleapis.com/user/nope"';
      return file;
    });
    edit(dir, "policies/payment-not-applied.json", (file) => {
      delete file.policy.alertStrategy.notificationRateLimit;
      return file;
    });
    const errors = errorsOf(dir);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('unknown notification channel "slack"'),
        expect.stringContaining('unknown log-based metric "nope"'),
        expect.stringContaining("payment-not-applied.json: a log-match policy needs"),
      ])
    );
  });

  it("rejects a real email address in a channel file", () => {
    const dir = copyConfig();
    edit(dir, "channels/email.json", (file) => ({ ...file, labels: { email_address: "someone@example.com" } }));
    expect(errorsOf(dir)).toEqual([expect.stringContaining("never a real address")]);
  });

  it("rejects a condition with two kinds of query", () => {
    const dir = copyConfig();
    edit(dir, "policies/payment-not-applied.json", (file) => {
      file.policy.conditions[0].conditionThreshold = { filter: "x" };
      return file;
    });
    expect(errorsOf(dir)[0]).toContain("exactly one of");
  });
});

describe("applying the monitoring config", () => {
  const config = loadMonitoringConfig(ROOT);
  const quiet = () => {};

  it("creates the channel, metrics and policies, pointing policies at the channel", async () => {
    const api = fakeApi();
    await applyMonitoring({ config, api, project: "p", email: "alerts@example.com", log: quiet });

    expect(api.state.channels).toHaveLength(1);
    expect(api.state.channels[0].labels.email_address).toBe("alerts@example.com");
    expect(Object.keys(api.state.metrics).sort()).toEqual([
      "search_engine_failures",
      "search_index_sync_failures",
      "search_requests",
    ]);
    expect(api.state.policies).toHaveLength(7);
    for (const policy of api.state.policies) {
      expect(policy.notificationChannels).toEqual([api.state.channels[0].name]);
      expect(policy.userLabels.managed_by).toBe("ops-monitoring");
    }
  });

  it("updates instead of duplicating on a second run", async () => {
    const api = fakeApi();
    await applyMonitoring({ config, api, project: "p", email: "alerts@example.com", log: quiet });
    const names = api.state.policies.map((policy) => policy.name).sort();
    api.state.writes.length = 0;

    await applyMonitoring({ config, api, project: "p", email: "alerts@example.com", log: quiet });

    expect(api.state.channels).toHaveLength(1);
    expect(api.state.policies.map((policy) => policy.name).sort()).toEqual(names);
    expect(api.state.writes.filter((write) => write.method === "POST")).toEqual([]);
  });

  it("reports a managed policy that is no longer in the files, without deleting it", async () => {
    const api = fakeApi();
    api.state.policies.push({ name: "projects/p/alertPolicies/old", userLabels: { managed_by: "ops-monitoring", policy_id: "old" } });
    const lines = [];

    await applyMonitoring({ config, api, project: "p", email: "alerts@example.com", log: (line) => lines.push(line) });

    expect(lines.some((line) => line.includes("Alert policy old"))).toBe(true);
    expect(api.state.policies.some((policy) => policy.name === "projects/p/alertPolicies/old")).toBe(true);
  });

  it("writes nothing on a dry run", async () => {
    const api = fakeApi();
    await applyMonitoring({ config, api, project: "p", email: "alerts@example.com", dryRun: true, log: quiet });
    expect(api.state.writes).toEqual([]);
  });

  it("needs an email for the channel", async () => {
    await expect(applyMonitoring({ config, api: fakeApi(), project: "p", email: "", log: quiet })).rejects.toThrow(
      /email/
    );
  });

  // Fails the first `times` policy creations the way Google does for a
  // log-based metric created a moment ago, or with another error.
  const failingCreates = (api, times, message) => {
    const request = api.request;
    let left = times;
    api.request = async (method, url, body) => {
      if (method === "POST" && url.endsWith("/alertPolicies") && left > 0) {
        left -= 1;
        const err = new Error("Request failed with status code 404");
        err.response = { data: { error: { message } } };
        throw err;
      }
      return request(method, url, body);
    };
    return api;
  };
  const NOT_READY =
    'Cannot find metric(s) that match type = "logging.googleapis.com/user/search_requests". If a metric was created recently, it could take up to 10 minutes to become available.';

  it("retries a policy whose new log-based metric isn't usable yet", async () => {
    const api = failingCreates(fakeApi(), 2, NOT_READY);
    const waits = [];

    await applyMonitoring({
      config,
      api,
      project: "p",
      email: "alerts@example.com",
      log: quiet,
      retryDelayMs: 60_000,
      sleep: async (ms) => waits.push(ms),
    });

    expect(waits).toEqual([60_000, 60_000]);
    expect(api.state.policies).toHaveLength(7);
  });

  it("applies the other policies when one fails, then lists the failure", async () => {
    const api = failingCreates(fakeApi(), 1, "Field alertPolicy.conditions[0] is invalid");

    const result = applyMonitoring({ config, api, project: "p", email: "alerts@example.com", log: quiet, sleep: async () => {} });

    await expect(result).rejects.toThrow(MonitoringApplyError);
    await expect(result).rejects.toThrow(/algolia-usage: Field alertPolicy.conditions\[0\] is invalid/);
    expect(api.state.policies).toHaveLength(6);
  });

  it("gives up after the last retry", async () => {
    const api = failingCreates(fakeApi(), 3, NOT_READY);

    const result = applyMonitoring({
      config,
      api,
      project: "p",
      email: "alerts@example.com",
      log: quiet,
      maxRetries: 2,
      sleep: async () => {},
    });

    await expect(result).rejects.toThrow(/algolia-usage: Cannot find metric/);
    expect(api.state.policies).toHaveLength(6);
  });

  it("builds the test logs where the real ones would land, marked as tests", () => {
    const api = buildTestEntries(config, "search-engine-down", "p", "us-central1");
    expect(api.resource).toMatchObject({ type: "cloud_run_revision", labels: { service_name: "my-fake-ecommerce-api" } });
    expect(api.entries).toHaveLength(6);
    expect(api.entries[0].jsonPayload).toMatchObject({ message: "Search engine call failed", test: true });

    const job = buildTestEntries(config, "search-index-unsynced", "p", "us-central1");
    expect(job.resource).toEqual({
      type: "cloud_run_job",
      labels: { project_id: "p", job_name: "sync-catalog", location: "us-central1" },
    });

    expect(() => buildTestEntries(config, "http-5xx", "p", "us-central1")).toThrow(/no test log/);
  });
});
