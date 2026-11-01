import { EMAIL_PLACEHOLDER, type MonitoringConfig, type TestLog } from "./config.js";

// Creates or updates, by id, everything in ops/monitoring/ in one project.
// Running it twice changes nothing the second time: each resource carries the
// label managed_by=ops-monitoring and its id, which is how it's found again.

export interface MonitoringApi {
  request<T>(method: "GET" | "POST" | "PATCH" | "PUT", url: string, body?: unknown): Promise<T>;
}

const MONITORING = "https://monitoring.googleapis.com/v3";
const LOGGING = "https://logging.googleapis.com/v2";
const MANAGED_BY = "ops-monitoring";

interface Labeled {
  name: string;
  userLabels?: Record<string, string>;
}

export interface ApplyOptions {
  config: MonitoringConfig;
  api: MonitoringApi;
  project: string;
  email: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}

const listAll = async <T>(api: MonitoringApi, url: string, key: string) => {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const page = await api.request<Record<string, unknown>>(
      "GET",
      `${url}?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`
    );
    items.push(...((page[key] as T[] | undefined) ?? []));
    pageToken = page.nextPageToken as string | undefined;
  } while (pageToken);
  return items;
};

const findManaged = <T extends Labeled>(items: T[], label: string, id: string) =>
  items.find((item) => item.userLabels?.managed_by === MANAGED_BY && item.userLabels?.[label] === id);

export const applyMonitoring = async ({ config, api, project, email, dryRun = false, log = console.log }: ApplyOptions) => {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Pass the email that receives the alerts");
  const projectPath = `projects/${project}`;
  const act = async (description: string, write: () => Promise<unknown>) => {
    log(`${dryRun ? "[dry run] " : ""}${description}`);
    if (!dryRun) await write();
  };

  // Channels first: policies point to them by their resource name.
  const channelNames: Record<string, string> = {};
  const existingChannels = await listAll<Labeled>(
    api,
    `${MONITORING}/${projectPath}/notificationChannels`,
    "notificationChannels"
  );
  for (const [id, channel] of Object.entries(config.channels)) {
    const body = {
      ...channel,
      labels: Object.fromEntries(
        Object.entries(channel.labels).map(([key, value]) => [key, value === EMAIL_PLACEHOLDER ? email : value])
      ),
      userLabels: { managed_by: MANAGED_BY, channel_id: id },
    };
    const existing = findManaged(existingChannels, "channel_id", id);
    if (existing) {
      channelNames[id] = existing.name;
      await act(`Update channel ${id}`, () => api.request("PATCH", `${MONITORING}/${existing.name}`, body));
    } else {
      channelNames[id] = `${projectPath}/notificationChannels/(new ${id})`;
      await act(`Create channel ${id}`, async () => {
        const created = await api.request<Labeled>("POST", `${MONITORING}/${projectPath}/notificationChannels`, body);
        channelNames[id] = created.name;
      });
    }
  }

  // Log-based metrics: update creates the metric when it doesn't exist yet.
  for (const metric of Object.values(config.metrics)) {
    await act(`Apply log-based metric ${metric.name}`, () =>
      api.request("PUT", `${LOGGING}/${projectPath}/metrics/${metric.name}`, metric)
    );
  }

  const existingPolicies = await listAll<Labeled>(api, `${MONITORING}/${projectPath}/alertPolicies`, "alertPolicies");
  for (const [id, { policy }] of Object.entries(config.policies)) {
    const body = {
      ...policy,
      notificationChannels: policy.notificationChannels.map((channel) => channelNames[channel]),
      userLabels: { managed_by: MANAGED_BY, policy_id: id },
    };
    const existing = findManaged(existingPolicies, "policy_id", id);
    if (existing) {
      // Without an update mask the stored policy is replaced by this one.
      await act(`Update alert policy ${id}`, () => api.request("PATCH", `${MONITORING}/${existing.name}`, body));
    } else {
      await act(`Create alert policy ${id}`, () =>
        api.request("POST", `${MONITORING}/${projectPath}/alertPolicies`, body)
      );
    }
  }

  // Policies created by an earlier version of the files are left alone, so
  // nothing is deleted by surprise; they're reported for a person to remove.
  const known = new Set(Object.keys(config.policies));
  for (const policy of existingPolicies) {
    const id = policy.userLabels?.policy_id;
    if (policy.userLabels?.managed_by === MANAGED_BY && id && !known.has(id)) {
      log(`Alert policy ${id} (${policy.name}) is no longer in ops/monitoring/: delete it by hand if that's intended`);
    }
  }
};

// The monitored resource a test log is written for, so it lands where the
// real one would and the metric filters (by resource type) see it.
const testResource = (target: TestLog["resource"], project: string, region: string) =>
  target === "api"
    ? {
        type: "cloud_run_revision",
        labels: {
          project_id: project,
          service_name: "my-fake-ecommerce-api",
          revision_name: "ops-monitoring-test",
          configuration_name: "my-fake-ecommerce-api",
          location: region,
        },
      }
    : { type: "cloud_run_job", labels: { project_id: project, job_name: target, location: region } };

// The entries.write body that fires a policy: its test log, `count` times,
// each marked test=true so nobody mistakes it for a real event.
export const buildTestEntries = (config: MonitoringConfig, policyId: string, project: string, region: string) => {
  const test = config.policies[policyId]?.test;
  if (!test) throw new Error(`Alert policy ${policyId} has no test log`);
  return {
    logName: `projects/${project}/logs/ops-monitoring-test`,
    resource: testResource(test.resource, project, region),
    entries: Array.from({ length: test.count }, () => ({
      severity: test.severity,
      jsonPayload: { ...test.payload, test: true },
    })),
  };
};

export const writeTestLogs = (api: MonitoringApi, body: ReturnType<typeof buildTestEntries>) =>
  api.request("POST", `${LOGGING}/entries:write`, body);
