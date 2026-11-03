import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

// The monitoring setup as code: notification channels, log-based metrics,
// uptime checks, services with their SLOs, alert policies and dashboards,
// one JSON file each under ops/monitoring/.
// A file holds the body the Cloud Monitoring or Cloud Logging API takes, so a
// PR shows exactly what will be created; the file name is its id.
//
// Two placeholders are filled in at apply time: ${PROJECT} (the project id)
// and, in a policy, ${uptime:<id>} (the id Google gives that uptime check).

export const RUNBOOK_URL =
  "https://roberto-bustos-hernandez.atlassian.net/wiki/spaces/ARQ/pages/24772610";

// Notification channel: the email address comes from the command line, so it
// never lands in the repo.
export const EMAIL_PLACEHOLDER = "${ALERT_EMAIL}";

const channelSchema = z.looseObject({
  type: z.string(),
  displayName: z.string().min(1),
  labels: z.record(z.string(), z.string()),
});

export const PROJECT_PLACEHOLDER = "${PROJECT}";
export const uptimePlaceholder = (id: string) => `\${uptime:${id}}`;

const uptimeCheckSchema = z.looseObject({
  displayName: z.string().min(1),
  monitoredResource: z.looseObject({ type: z.string(), labels: z.record(z.string(), z.string()) }),
  period: z.string(),
  timeout: z.string(),
  // Google requires at least three checker regions.
  selectedRegions: z.array(z.string()).min(3),
});

const metricSchema = z.looseObject({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "metric names are lowercase with underscores"),
  description: z.string().min(1),
  filter: z.string().min(1),
});

// A service and its SLOs. The file name is the service id and each key of
// "slos" an SLO id; an alert policy watches an SLO's error budget with
// select_slo_burn_rate("projects/${PROJECT}/services/<id>/serviceLevelObjectives/<slo>", ...).
const sloSchema = z.looseObject({
  displayName: z.string().min(1),
  goal: z.number().gt(0).lt(1),
  rollingPeriod: z.string(),
  serviceLevelIndicator: z.looseObject({}),
});

const serviceFileSchema = z.object({
  service: z.looseObject({ displayName: z.string().min(1), custom: z.object({}) }),
  slos: z
    .record(z.string().regex(/^[a-z][a-z0-9-]*$/, "SLO ids are lowercase with hyphens"), sloSchema)
    .refine((slos) => Object.keys(slos).length > 0, "a service has at least one SLO"),
});

// A dashboard: every tile has a title, so nobody has to guess what a chart is.
const dashboardSchema = z.looseObject({
  displayName: z.string().min(1),
  mosaicLayout: z.looseObject({
    columns: z.int(),
    tiles: z.array(z.looseObject({ widget: z.looseObject({ title: z.string().min(1) }) })).min(1),
  }),
});

const conditionSchema = z
  .looseObject({
    displayName: z.string().min(1),
    conditionMatchedLog: z.looseObject({ filter: z.string().min(1) }).optional(),
    conditionThreshold: z.looseObject({ filter: z.string().min(1) }).optional(),
    conditionAbsent: z.looseObject({ filter: z.string().min(1), duration: z.string() }).optional(),
    conditionPrometheusQueryLanguage: z.looseObject({ query: z.string().min(1) }).optional(),
  })
  .refine(
    (condition) =>
      [
        condition.conditionMatchedLog,
        condition.conditionThreshold,
        condition.conditionAbsent,
        condition.conditionPrometheusQueryLanguage,
      ].filter(Boolean).length === 1,
    "a condition has exactly one of conditionMatchedLog, conditionThreshold, conditionAbsent or conditionPrometheusQueryLanguage"
  );

// A test log: what to write so the policy fires once it's applied. Policies
// that watch a Google metric (5xx responses, uptime, job runs) have none.
const testSchema = z.object({
  resource: z.enum(["api", "sync-catalog", "process-inventory"]),
  severity: z.enum(["INFO", "WARNING", "ERROR"]),
  payload: z.record(z.string(), z.unknown()).refine((payload) => typeof payload.message === "string", {
    message: "the payload needs a message",
  }),
  count: z.int().min(1).max(1000),
});

const policyFileSchema = z.object({
  policy: z.looseObject({
    displayName: z.string().min(1),
    severity: z.enum(["CRITICAL", "ERROR", "WARNING"]),
    combiner: z.literal("OR"),
    documentation: z.looseObject({
      mimeType: z.literal("text/markdown"),
      content: z.string().includes(RUNBOOK_URL, { message: "the documentation links to its Runbook section" }),
    }),
    conditions: z.array(conditionSchema).min(1),
    notificationChannels: z.array(z.string()).min(1),
    alertStrategy: z
      .looseObject({ notificationRateLimit: z.object({ period: z.string() }).optional() })
      .optional(),
  }),
  test: testSchema.optional(),
});

export type Channel = z.infer<typeof channelSchema>;
export type UptimeCheck = z.infer<typeof uptimeCheckSchema>;
export type LogMetric = z.infer<typeof metricSchema>;
export type PolicyFile = z.infer<typeof policyFileSchema>;
export type ServiceFile = z.infer<typeof serviceFileSchema>;
export type Dashboard = z.infer<typeof dashboardSchema>;
export type TestLog = z.infer<typeof testSchema>;

export interface MonitoringConfig {
  channels: Record<string, Channel>;
  metrics: Record<string, LogMetric>;
  uptimeChecks: Record<string, UptimeCheck>;
  services: Record<string, ServiceFile>;
  policies: Record<string, PolicyFile>;
  dashboards: Record<string, Dashboard>;
}

const ID = /^[a-z][a-z0-9-]*$/;

const readDir = <T>(dir: string, schema: z.ZodType<T>, errors: string[]) => {
  const entries: Record<string, T> = {};
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    const id = basename(file, ".json");
    const where = `${basename(dir)}/${file}`;
    if (!ID.test(id)) errors.push(`${where}: file names are lowercase with hyphens`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (err) {
      errors.push(`${where}: invalid JSON (${(err as Error).message})`);
      continue;
    }
    const result = schema.safeParse(parsed);
    if (result.success) entries[id] = result.data;
    else errors.push(...result.error.issues.map((issue) => `${where}: ${issue.path.join(".")}: ${issue.message}`));
  }
  return entries;
};

// Every query a condition runs, whatever its kind.
export const conditionQuery = (condition: PolicyFile["policy"]["conditions"][number]) =>
  condition.conditionThreshold?.filter ??
  condition.conditionAbsent?.filter ??
  condition.conditionMatchedLog?.filter ??
  condition.conditionPrometheusQueryLanguage?.query ??
  "";

// The log-based metrics a text reads, by filter (logging.googleapis.com/user/<name>)
// or by PromQL (logging_googleapis_com:user_<name>, plus _count, _sum or
// _bucket for a distribution). PromQL suffixes are ambiguous with names, so
// either reading is accepted.
const logMetricsIn = (text: string) =>
  [...text.matchAll(/logging\.googleapis\.com\/user\/([a-z0-9_]+)|logging_googleapis_com:user_([a-z0-9_]+)/g)].map(
    ([, filterName, promName]) => (filterName ? [filterName] : [promName, promName.replace(/_(count|sum|bucket)$/, "")])
  );

// The resource types a log-based metric counts on, from its filter. PromQL
// refuses a metric that lives on more than one ("must specify a label matcher
// on the 'monitored_resource' label"), and the error only shows once the
// metric has data, so it's checked here instead.
const resourceTypesOf = (filter: string) =>
  new Set([...filter.matchAll(/resource\.type="([a-z_]+)"/g)].map(([, type]) => type));

// Every PromQL selector of a log-based metric in a text: its name (with the
// _count, _sum or _bucket suffix PromQL adds to a distribution) and its labels.
const promSelectors = (text: string) =>
  [...text.matchAll(/logging_googleapis_com:user_([a-z0-9_]+)(\{[^}]*\})?/g)].map(([, name, labels = ""]) => ({
    names: [name, name.replace(/_(count|sum|bucket)$/, "")],
    labels,
  }));

// Checks that hold across files: every channel a policy names exists, every
// log-based metric a condition, SLO or dashboard reads is defined, every SLO
// a policy watches is defined, a PromQL query names the resource of a metric
// that lives on several, and log-match policies set the notification rate
// limit the API requires for them.
export const crossCheck = ({ channels, metrics, uptimeChecks, services, policies, dashboards }: MonitoringConfig) => {
  const errors: string[] = [];
  const metricNames = new Set(Object.values(metrics).map((metric) => metric.name));
  const metricResources = new Map(Object.values(metrics).map((metric) => [metric.name, resourceTypesOf(metric.filter)]));
  const unknownMetrics = (where: string, text: string) => {
    for (const readings of logMetricsIn(text)) {
      if (!readings.some((name) => metricNames.has(name))) errors.push(`${where}: unknown log-based metric "${readings[0]}"`);
    }
    for (const { names, labels } of promSelectors(text)) {
      const name = names.find((candidate) => metricResources.has(candidate));
      if (name && (metricResources.get(name)?.size ?? 0) > 1 && !labels.includes("monitored_resource=")) {
        errors.push(`${where}: PromQL on "${name}" must set monitored_resource, because the metric is on several resource types`);
      }
    }
  };
  for (const [id, { policy }] of Object.entries(policies)) {
    for (const channel of policy.notificationChannels) {
      if (!channels[channel]) errors.push(`policies/${id}.json: unknown notification channel "${channel}"`);
    }
    for (const condition of policy.conditions) {
      const text = conditionQuery(condition);
      unknownMetrics(`policies/${id}.json`, text);
      for (const [, service, slo] of text.matchAll(/services\/([a-z0-9-]+)\/serviceLevelObjectives\/([a-z0-9-]+)/g)) {
        if (!services[service]?.slos[slo]) errors.push(`policies/${id}.json: unknown SLO "${service}/${slo}"`);
      }
      for (const [, check] of text.matchAll(/\$\{uptime:([a-z0-9-]+)\}/g)) {
        if (!uptimeChecks[check]) errors.push(`policies/${id}.json: unknown uptime check "${check}"`);
      }
      if (condition.conditionMatchedLog && !policy.alertStrategy?.notificationRateLimit) {
        errors.push(`policies/${id}.json: a log-match policy needs alertStrategy.notificationRateLimit`);
      }
    }
  }
  for (const [id, file] of Object.entries(services)) unknownMetrics(`services/${id}.json`, JSON.stringify(file.slos));
  for (const [id, dashboard] of Object.entries(dashboards)) unknownMetrics(`dashboards/${id}.json`, JSON.stringify(dashboard));
  for (const [id, channel] of Object.entries(channels)) {
    if (channel.type === "email" && channel.labels.email_address !== EMAIL_PLACEHOLDER) {
      errors.push(`channels/${id}.json: email_address must be ${EMAIL_PLACEHOLDER}, never a real address`);
    }
  }
  return errors;
};

export class MonitoringConfigError extends Error {
  constructor(readonly errors: string[]) {
    super(`Invalid monitoring config:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
  }
}

export const loadMonitoringConfig = (root: string): MonitoringConfig => {
  const errors: string[] = [];
  const config = {
    channels: readDir(join(root, "channels"), channelSchema, errors),
    metrics: readDir(join(root, "metrics"), metricSchema, errors),
    uptimeChecks: readDir(join(root, "uptime-checks"), uptimeCheckSchema, errors),
    services: readDir(join(root, "services"), serviceFileSchema, errors),
    policies: readDir(join(root, "policies"), policyFileSchema, errors),
    dashboards: readDir(join(root, "dashboards"), dashboardSchema, errors),
  };
  errors.push(...crossCheck(config));
  if (errors.length > 0) throw new MonitoringConfigError(errors);
  return config;
};
