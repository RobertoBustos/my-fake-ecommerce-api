import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

// The monitoring setup as code: notification channels, log-based metrics and
// alert policies, one JSON file each under ops/monitoring/. A file holds the
// body the Cloud Monitoring or Cloud Logging API takes, so a PR shows exactly
// what will be created; the file name is its id.

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

const metricSchema = z.looseObject({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "metric names are lowercase with underscores"),
  description: z.string().min(1),
  filter: z.string().min(1),
});

const conditionSchema = z
  .looseObject({
    displayName: z.string().min(1),
    conditionMatchedLog: z.looseObject({ filter: z.string().min(1) }).optional(),
    conditionThreshold: z.looseObject({ filter: z.string().min(1) }).optional(),
    conditionPrometheusQueryLanguage: z.looseObject({ query: z.string().min(1) }).optional(),
  })
  .refine(
    (condition) =>
      [condition.conditionMatchedLog, condition.conditionThreshold, condition.conditionPrometheusQueryLanguage].filter(
        Boolean
      ).length === 1,
    "a condition has exactly one of conditionMatchedLog, conditionThreshold or conditionPrometheusQueryLanguage"
  );

// A test log: what to write so the policy fires once it's applied. Policies
// that watch a Google metric (5xx responses) have none.
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
export type LogMetric = z.infer<typeof metricSchema>;
export type PolicyFile = z.infer<typeof policyFileSchema>;
export type TestLog = z.infer<typeof testSchema>;

export interface MonitoringConfig {
  channels: Record<string, Channel>;
  metrics: Record<string, LogMetric>;
  policies: Record<string, PolicyFile>;
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

// Checks that hold across files: every channel a policy names exists, every
// log-based metric a condition reads is defined, and log-match policies set
// the notification rate limit the API requires for them.
export const crossCheck = ({ channels, metrics, policies }: MonitoringConfig) => {
  const errors: string[] = [];
  const metricNames = new Set(Object.values(metrics).map((metric) => metric.name));
  for (const [id, { policy }] of Object.entries(policies)) {
    for (const channel of policy.notificationChannels) {
      if (!channels[channel]) errors.push(`policies/${id}.json: unknown notification channel "${channel}"`);
    }
    for (const condition of policy.conditions) {
      const text =
        condition.conditionThreshold?.filter ??
        condition.conditionMatchedLog?.filter ??
        condition.conditionPrometheusQueryLanguage?.query ??
        "";
      for (const [, name] of text.matchAll(/logging\.googleapis\.com\/user\/([a-z0-9_]+)/g)) {
        if (!metricNames.has(name)) errors.push(`policies/${id}.json: unknown log-based metric "${name}"`);
      }
      if (condition.conditionMatchedLog && !policy.alertStrategy?.notificationRateLimit) {
        errors.push(`policies/${id}.json: a log-match policy needs alertStrategy.notificationRateLimit`);
      }
    }
  }
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
    policies: readDir(join(root, "policies"), policyFileSchema, errors),
  };
  errors.push(...crossCheck(config));
  if (errors.length > 0) throw new MonitoringConfigError(errors);
  return config;
};
