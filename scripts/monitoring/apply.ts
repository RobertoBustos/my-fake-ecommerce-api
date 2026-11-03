import {
  EMAIL_PLACEHOLDER,
  PROJECT_PLACEHOLDER,
  uptimePlaceholder,
  type MonitoringConfig,
  type TestLog,
} from "./config.js";

// Creates or updates, by id, everything in ops/monitoring/ in one project.
// Running it twice changes nothing the second time: each resource carries the
// label managed_by=ops-monitoring and its id, which is how it's found again
// (services and SLOs take their id from the file itself).

export interface MonitoringApi {
  request<T>(method: "GET" | "POST" | "PATCH" | "PUT", url: string, body?: unknown): Promise<T>;
}

const MONITORING = "https://monitoring.googleapis.com/v3";
// Dashboards live in v1 of the same API.
const DASHBOARDS = "https://monitoring.googleapis.com/v1";
const LOGGING = "https://logging.googleapis.com/v2";
const MANAGED_BY = "ops-monitoring";

interface Labeled {
  name: string;
  userLabels?: Record<string, string>;
}

interface LabeledDashboard {
  name: string;
  etag?: string;
  labels?: Record<string, string>;
}

export interface ApplyOptions {
  config: MonitoringConfig;
  api: MonitoringApi;
  project: string;
  email: string;
  dryRun?: boolean;
  log?: (line: string) => void;
  // How long to wait before retrying a policy whose new log-based metric
  // isn't usable yet, and how many times.
  retryDelayMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class MonitoringApplyError extends Error {
  constructor(readonly failures: { id: string; error: string }[]) {
    super(
      `Could not apply ${failures.length} resource${failures.length === 1 ? "" : "s"}:\n` +
        failures.map(({ id, error }) => `  - ${id}: ${error}`).join("\n")
    );
  }
}

// The API's own message when there is one (the client's error message is
// generic), so a failure says what Google rejected.
const errorMessage = (err: unknown) => {
  const apiMessage = (err as { response?: { data?: { error?: { message?: unknown } } } }).response?.data?.error
    ?.message;
  return typeof apiMessage === "string" ? apiMessage : (err as Error).message;
};

// A log-based metric takes up to 10 minutes to be usable in an alert policy
// or an SLO after it's created or updated; until then writing one fails. The
// wording differs by API and by case, so every known form counts: the v1.7.0
// release left five policies unapplied because only the first was recognized.
export const isMetricNotReady = (message: string) =>
  /cannot find metric|metric referenced by the provided filter is unknown|could not find (the )?metric|unknown metric/i.test(
    message
  );

// What decides a log-based metric's behavior, in a form that compares equal
// however Google orders it or fills in defaults (a STRING label comes back
// without its valueType, and the descriptor gains a name and a type).
interface LogMetricBody {
  filter?: string;
  description?: string;
  valueExtractor?: string;
  labelExtractors?: Record<string, string>;
  bucketOptions?: unknown;
  metricDescriptor?: {
    metricKind?: string;
    valueType?: string;
    unit?: string;
    labels?: { key: string; valueType?: string; description?: string }[];
  };
}

const metricShape = (metric: LogMetricBody) => {
  const descriptor = metric.metricDescriptor ?? {};
  return JSON.stringify({
    filter: metric.filter,
    description: metric.description,
    valueExtractor: metric.valueExtractor ?? "",
    labelExtractors: Object.entries(metric.labelExtractors ?? {}).sort(),
    bucketOptions: metric.bucketOptions ?? null,
    metricKind: descriptor.metricKind,
    valueType: descriptor.valueType,
    unit: descriptor.unit ?? "",
    labels: (descriptor.labels ?? [])
      .map(({ key, valueType, description }) => [key, valueType ?? "STRING", description ?? ""])
      .sort(),
  });
};

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

// Fills the placeholders of a body: every text in it, at any depth.
const fill = <T>(body: T, values: Record<string, string>): T =>
  JSON.parse(
    JSON.stringify(body, (_key, value) =>
      typeof value === "string"
        ? Object.entries(values).reduce((text, [placeholder, real]) => text.split(placeholder).join(real), value)
        : value
    )
  );

// The fields of an uptime check Google lets an update change; the rest
// (what it checks, the checker type) are fixed at creation.
const UPTIME_UPDATE_MASK = "displayName,period,timeout,httpCheck,contentMatchers,selectedRegions,userLabels";

export const applyMonitoring = async ({
  config,
  api,
  project,
  email,
  dryRun = false,
  log = console.log,
  retryDelayMs = 60_000,
  maxRetries = 10,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: ApplyOptions) => {
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
  // One that hasn't changed is left alone: updating a metric makes it
  // unusable for a few minutes, and the policies that read it would fail.
  const existingMetrics = await listAll<LogMetricBody & { name: string }>(
    api,
    `${LOGGING}/${projectPath}/metrics`,
    "metrics"
  );
  for (const metric of Object.values(config.metrics)) {
    const current = existingMetrics.find((item) => item.name === metric.name);
    if (current && metricShape(current) === metricShape(metric as LogMetricBody)) {
      log(`Log-based metric ${metric.name} unchanged`);
      continue;
    }
    await act(`Apply log-based metric ${metric.name}`, () =>
      api.request("PUT", `${LOGGING}/${projectPath}/metrics/${metric.name}`, metric)
    );
  }

  const failures: { id: string; error: string }[] = [];
  // Retries while a metric is still too new to use, then gives up on that
  // policy or SLO only: the rest are still applied, and the failures are listed at
  // the end.
  const writeWithRetry = async (id: string, write: () => Promise<unknown>) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await write();
      } catch (err) {
        const message = errorMessage(err);
        if (!isMetricNotReady(message) || attempt >= maxRetries) throw new Error(message, { cause: err });
        log(`  ${id}: a metric isn't usable yet; retrying in ${Math.round(retryDelayMs / 1000)} s (${attempt + 1}/${maxRetries})`);
        await sleep(retryDelayMs);
      }
    }
  };

  // Uptime checks: Google gives each one its id on creation, and the policies
  // that watch it name it by that id.
  const placeholders: Record<string, string> = { [PROJECT_PLACEHOLDER]: project };
  const existingChecks = await listAll<Labeled>(
    api,
    `${MONITORING}/${projectPath}/uptimeCheckConfigs`,
    "uptimeCheckConfigs"
  );
  for (const [id, check] of Object.entries(config.uptimeChecks)) {
    const body = fill({ ...check, userLabels: { managed_by: MANAGED_BY, uptime_id: id } }, placeholders);
    const existing = findManaged(existingChecks, "uptime_id", id);
    if (existing) {
      placeholders[uptimePlaceholder(id)] = existing.name.split("/").pop() as string;
      await act(`Update uptime check ${id}`, () =>
        api.request("PATCH", `${MONITORING}/${existing.name}?updateMask=${UPTIME_UPDATE_MASK}`, body)
      );
    } else {
      placeholders[uptimePlaceholder(id)] = `(new ${id})`;
      await act(`Create uptime check ${id}`, async () => {
        const created = await api.request<Labeled>("POST", `${MONITORING}/${projectPath}/uptimeCheckConfigs`, body);
        placeholders[uptimePlaceholder(id)] = created.name.split("/").pop() as string;
      });
    }
  }

  // Services and their SLOs, before the policies that watch their budgets.
  // Both take the id from the file, so they're found again by name. An SLO
  // on a log-based metric created in this run waits for it like a policy.
  const existingServices = await listAll<Labeled>(api, `${MONITORING}/${projectPath}/services`, "services");
  for (const [id, { service, slos }] of Object.entries(config.services)) {
    const body = { ...service, userLabels: { managed_by: MANAGED_BY } };
    const existing = existingServices.find((item) => item.name.split("/").pop() === id);
    const serviceName = `${projectPath}/services/${id}`;
    try {
      if (existing) {
        await act(`Update service ${id}`, () => api.request("PATCH", `${MONITORING}/${existing.name}`, body));
      } else {
        await act(`Create service ${id}`, () =>
          api.request("POST", `${MONITORING}/${projectPath}/services?serviceId=${id}`, body)
        );
      }
    } catch (err) {
      failures.push({ id: `service ${id}`, error: errorMessage(err) });
      log(`  service ${id} failed: ${errorMessage(err)}`);
      continue;
    }
    // A service that doesn't exist yet (a dry run) has no SLOs to find.
    const existingSlos = existing
      ? await listAll<Labeled>(api, `${MONITORING}/${existing.name}/serviceLevelObjectives`, "serviceLevelObjectives")
      : [];
    for (const [sloId, slo] of Object.entries(slos)) {
      const found = existingSlos.find((item) => item.name.split("/").pop() === sloId);
      const label = `${id}/${sloId}`;
      try {
        if (found) {
          await act(`Update SLO ${label}`, () =>
            writeWithRetry(label, () => api.request("PATCH", `${MONITORING}/${found.name}`, slo))
          );
        } else {
          await act(`Create SLO ${label}`, () =>
            writeWithRetry(label, () =>
              api.request(
                "POST",
                `${MONITORING}/${serviceName}/serviceLevelObjectives?serviceLevelObjectiveId=${sloId}`,
                slo
              )
            )
          );
        }
      } catch (err) {
        failures.push({ id: `SLO ${label}`, error: (err as Error).message });
        log(`  SLO ${label} failed: ${(err as Error).message}`);
      }
    }
  }

  const existingPolicies = await listAll<Labeled>(api, `${MONITORING}/${projectPath}/alertPolicies`, "alertPolicies");
  for (const [id, { policy }] of Object.entries(config.policies)) {
    const body = fill(
      {
        ...policy,
        notificationChannels: policy.notificationChannels.map((channel) => channelNames[channel]),
        userLabels: { managed_by: MANAGED_BY, policy_id: id },
      },
      placeholders
    );
    const existing = findManaged(existingPolicies, "policy_id", id);
    try {
      if (existing) {
        // Without an update mask the stored policy is replaced by this one.
        await act(`Update alert policy ${id}`, () =>
          writeWithRetry(id, () => api.request("PATCH", `${MONITORING}/${existing.name}`, body))
        );
      } else {
        await act(`Create alert policy ${id}`, () =>
          writeWithRetry(id, () => api.request("POST", `${MONITORING}/${projectPath}/alertPolicies`, body))
        );
      }
    } catch (err) {
      failures.push({ id, error: (err as Error).message });
      log(`  ${id} failed: ${(err as Error).message}`);
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

  // Dashboards last: a chart of a metric that doesn't exist yet just shows
  // no data, so nothing waits. The update sends the etag it read, so a
  // change someone made in the console since then isn't silently lost.
  const existingDashboards = await listAll<LabeledDashboard>(api, `${DASHBOARDS}/${projectPath}/dashboards`, "dashboards");
  for (const [id, dashboard] of Object.entries(config.dashboards)) {
    const body = fill({ ...dashboard, labels: { managed_by: MANAGED_BY, dashboard_id: id } }, placeholders);
    const existing = existingDashboards.find(
      (item) => item.labels?.managed_by === MANAGED_BY && item.labels?.dashboard_id === id
    );
    try {
      if (existing) {
        await act(`Update dashboard ${id}`, () =>
          api.request("PATCH", `${DASHBOARDS}/${existing.name}`, { ...body, etag: existing.etag })
        );
      } else {
        await act(`Create dashboard ${id}`, () => api.request("POST", `${DASHBOARDS}/${projectPath}/dashboards`, body));
      }
    } catch (err) {
      failures.push({ id: `dashboard ${id}`, error: errorMessage(err) });
      log(`  dashboard ${id} failed: ${errorMessage(err)}`);
    }
  }

  if (failures.length > 0) throw new MonitoringApplyError(failures);
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
