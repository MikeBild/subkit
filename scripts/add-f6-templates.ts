// F6: append six net-new connector templates to templates.json.
//
// These templates do not exist in the catalog today (verified by `jq`
// on 2026-05-01). They unblock Workstream B (recipes) and Workstream C
// (chained-auth scenarios) per the plan at
// /Users/mikebild/.claude/plans/make-a-deep-internet-flickering-sutherland.md.
//
// Idempotent — re-running on an already-amended file is a no-op
// (skips templates whose slug already exists).
//
// Recipes are intentionally empty here. Each template ships its
// initial recipes via Workstream B in subsequent PRs (the recipe
// authoring iteration owns vendor-doc lookups + dry-run validation).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TEMPLATES_PATH = resolve(import.meta.dir, "..", "apps/engine/src/connectors/templates.json");

type Template = {
  version: 1;
  slug: string;
  name: string;
  driver: string;
  base_url: string | null;
  auth_type: string;
  oauth: unknown | null;
  default_skill: string | null;
  ingestion_source: string | null;
  ingestion_url: string | null;
  icon: string;
  description: string;
  category: string;
  tags: string[];
  setup_instructions: string;
  auth_options: Array<Record<string, unknown>>;
  url_pattern: string | null;
  keywords: string[];
  inline_schema: unknown | null;
  probe_endpoint: unknown | null;
  credential_hints: Array<Record<string, unknown>>;
  base_url_options: Array<Record<string, unknown>>;
  pagination_defaults: unknown | null;
  capabilities: { webhooks: boolean; webhook_events: string[]; rate_limits: unknown | null };
  operator_quirks: Record<string, string>;
  recipes: unknown[];
  aws_service: string | null;
  aws_region: string | null;
};

const AWS_CRED_HINTS = [
  {
    field: "access_key_id",
    label: "AWS Access Key ID",
    placeholder: "AKIA...",
    doc_url: null,
    secret: false,
  },
  {
    field: "secret_access_key",
    label: "AWS Secret Access Key",
    placeholder: "",
    doc_url: null,
    secret: true,
  },
  {
    field: "session_token",
    label: "AWS Session Token (optional, STS)",
    placeholder: "",
    doc_url: null,
    secret: true,
  },
];

function awsTemplate(overrides: {
  slug: string;
  name: string;
  description: string;
  awsService: string;
  baseHost: string;
  setup: string;
  quirks: Record<string, string>;
  keywords: string[];
  iconBasename?: string;
  awsRegion?: string;
}): Template {
  const region = overrides.awsRegion ?? "us-east-1";
  const baseUrl = `https://${overrides.baseHost}`;
  return {
    version: 1,
    slug: overrides.slug,
    name: overrides.name,
    driver: "http",
    base_url: baseUrl,
    auth_type: "aws_sigv4",
    oauth: null,
    default_skill: null,
    ingestion_source: "unsupported",
    ingestion_url: null,
    icon: overrides.iconBasename ?? `${overrides.slug}.svg`,
    description: overrides.description,
    category: "aws",
    tags: ["rest", "aws", "sigv4"],
    setup_instructions: overrides.setup,
    auth_options: [
      {
        auth_type: "aws_sigv4",
        label: "AWS IAM SigV4",
        description: `Sign every request with AWS Signature V4 using aws_service=${overrides.awsService}.`,
        oauth: null,
      },
    ],
    url_pattern: `^https:\\/\\/${overrides.baseHost.replace(/\./g, "\\.").replace(region, "[a-z0-9-]+")}(\\/|$)`,
    keywords: overrides.keywords,
    inline_schema: null,
    probe_endpoint: null,
    credential_hints: AWS_CRED_HINTS,
    base_url_options: [],
    pagination_defaults: null,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
    operator_quirks: overrides.quirks,
    recipes: [],
    aws_service: overrides.awsService,
    aws_region: region,
  };
}

const NEW_TEMPLATES: Template[] = [
  awsTemplate({
    slug: "aws-cloudwatch-logs",
    name: "AWS CloudWatch Logs",
    description: "Amazon CloudWatch Logs API for log ingestion + Logs Insights query.",
    awsService: "logs",
    baseHost: "logs.us-east-1.amazonaws.com",
    setup:
      "Set config.aws_region and config.aws_service=logs. IAM principal needs logs:Put*, logs:Describe*, logs:Filter*, logs:GetQueryResults, logs:StartQuery as needed by the workflow.",
    keywords: ["cloudwatch logs", "log group", "logs insights", "tail logs", "put log event"],
    quirks: {
      auth: "Use aws_service=logs. SigV4 region must match base_url region (logs.<region>.amazonaws.com).",
      pagination:
        "DescribeLogGroups / FilterLogEvents return `nextToken`; pass back as `nextToken` in the body, not as a query param. The X-Amz-Target header switches the action (Logs_20140328.<Action>).",
      general:
        "Log ingestion endpoints (PutLogEvents) require a `sequenceToken` from the previous PutLogEvents response or DescribeLogStreams. Treat any 4xx with InvalidSequenceTokenException as recoverable — re-fetch the token and retry once.",
    },
    iconBasename: "aws-cloudwatch.svg",
  }),
  awsTemplate({
    slug: "aws-cloudwatch-metrics",
    name: "AWS CloudWatch Metrics",
    description: "Amazon CloudWatch Metrics API for metric ingestion + statistic queries.",
    awsService: "monitoring",
    baseHost: "monitoring.us-east-1.amazonaws.com",
    setup:
      "Set config.aws_region and config.aws_service=monitoring. IAM principal needs cloudwatch:PutMetricData, cloudwatch:GetMetricStatistics, cloudwatch:ListMetrics as needed.",
    keywords: ["cloudwatch metrics", "put metric data", "get metric statistics", "list metrics"],
    quirks: {
      auth: "Use aws_service=monitoring (the Cloudwatch service id is `monitoring`, not `cloudwatch`).",
      pagination: "ListMetrics returns `NextToken`; resend as form param.",
      general:
        "PutMetricData uses the Query (form-encoded) protocol with Action=PutMetricData and Version=2010-08-01. Custom namespaces are billable per-metric.",
    },
    iconBasename: "aws-cloudwatch.svg",
  }),
  awsTemplate({
    slug: "aws-cloudwatch-alarms",
    name: "AWS CloudWatch Alarms",
    description:
      "Amazon CloudWatch Alarms API. Pairs with aws-cloudwatch-metrics (same monitoring endpoint) but workflows are alarm-state focused.",
    awsService: "monitoring",
    baseHost: "monitoring.us-east-1.amazonaws.com",
    setup:
      "Set config.aws_region and config.aws_service=monitoring. IAM principal needs cloudwatch:PutMetricAlarm, cloudwatch:DescribeAlarms, cloudwatch:SetAlarmState, cloudwatch:DisableAlarmActions, cloudwatch:EnableAlarmActions as needed.",
    keywords: ["cloudwatch alarms", "describe alarms", "set alarm state", "disable alarm actions"],
    quirks: {
      auth: "Use aws_service=monitoring. Same endpoint as aws-cloudwatch-metrics; the template is split for workflow shape clarity, not for endpoint reasons.",
      pagination: "DescribeAlarms returns `NextToken` via form-encoded paging.",
      general:
        "PutMetricAlarm and SetAlarmState are external writes — require operator confirmation. Alarms in INSUFFICIENT_DATA / ALARM state can be manually transitioned via SetAlarmState for runbook drills.",
    },
    iconBasename: "aws-cloudwatch.svg",
  }),
  awsTemplate({
    slug: "aws-sts",
    name: "AWS STS",
    description:
      "AWS Security Token Service — temporary-credential issuance for cross-account / cross-role access.",
    awsService: "sts",
    baseHost: "sts.amazonaws.com",
    setup:
      "Set config.aws_service=sts. STS is global by default; set config.aws_region only when targeting a regional STS endpoint (e.g. sts.eu-west-1.amazonaws.com) for FIPS or in-region calls.",
    keywords: ["assume role", "sts", "temporary credentials", "get caller identity"],
    quirks: {
      auth: "Use aws_service=sts. AssumeRole returns `Credentials.{AccessKeyId,SecretAccessKey,SessionToken,Expiration}` — propagate `SessionToken` as `session_token` for downstream sigv4 calls. Tokens expire (default 1h, max 12h with `DurationSeconds`).",
      pagination: "STS responses are not paginated.",
      general:
        "AssumeRoleWithWebIdentity supports OIDC tokens (e.g. GitHub OIDC, Auth0). The Token output of AssumeRole is sensitive; downstream steps consuming it should mark `outputs.SessionToken.secret = true` once the secret-output flag (Workstream A7) ships.",
    },
    iconBasename: "aws-sts.svg",
    awsRegion: "us-east-1",
  }),
  awsTemplate({
    slug: "aws-eventbridge",
    name: "AWS EventBridge",
    description: "Amazon EventBridge API for event publishing + rule management.",
    awsService: "events",
    baseHost: "events.us-east-1.amazonaws.com",
    setup:
      "Set config.aws_region and config.aws_service=events. IAM principal needs events:PutEvents, events:ListRules, events:PutRule, events:ListTargetsByRule as needed.",
    keywords: ["eventbridge", "put events", "list rules", "create rule", "event bus"],
    quirks: {
      auth: "Use aws_service=events.",
      pagination: "ListRules / ListTargetsByRule return `NextToken`; pass back in JSON body.",
      general:
        "PutEvents accepts up to 10 entries per call. Each entry has a `Source`, `DetailType`, `Detail` (JSON string), and optional `EventBusName`. Custom event buses must exist before PutEvents references them.",
    },
    iconBasename: "aws-eventbridge.svg",
  }),
  // OAuth2 generic template — for chained-auth recipes that need a
  // reusable OAuth2 endpoint surface independent of any single vendor.
  {
    version: 1,
    slug: "oauth2-generic",
    name: "OAuth2 Generic",
    driver: "http",
    base_url: null,
    auth_type: "header",
    oauth: null,
    default_skill: null,
    ingestion_source: "unsupported",
    ingestion_url: null,
    icon: "oauth2.svg",
    description:
      "Reusable OAuth2 endpoints (token exchange, refresh, introspect, revoke, client_credentials, device code) for arbitrary providers. Used by chained-auth recipes that compose token issuance with downstream API calls.",
    category: "enterprise",
    tags: ["oauth2", "auth", "generic"],
    setup_instructions:
      "Set base_url to the provider's OAuth2 token / authorize endpoint host. Configure client_id (config), client_secret (credential, secret), and one or more grant types in operator quirks.",
    auth_options: [
      {
        auth_type: "header",
        label: "OAuth2 client credentials in header (Authorization: Basic)",
        description:
          "Most token endpoints accept the client_id+client_secret as Basic auth in the Authorization header. This template defaults to that; specific recipes can override via header steps.",
        oauth: null,
      },
    ],
    url_pattern: null,
    keywords: [
      "oauth2",
      "token exchange",
      "refresh token",
      "client credentials",
      "device code",
      "introspect",
      "revoke",
    ],
    inline_schema: null,
    probe_endpoint: null,
    credential_hints: [
      {
        field: "client_id",
        label: "OAuth2 Client ID",
        placeholder: "",
        doc_url: null,
        secret: false,
      },
      {
        field: "client_secret",
        label: "OAuth2 Client Secret",
        placeholder: "",
        doc_url: null,
        secret: true,
      },
    ],
    base_url_options: [],
    pagination_defaults: null,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
    operator_quirks: {
      auth: "Most providers accept client_id + client_secret as Basic auth (Authorization: Basic base64(client_id:client_secret)). Some require them in the form body instead — recipes can switch via the body field.",
      pagination: "OAuth2 token endpoints are not paginated.",
      general:
        "Token responses include `access_token`, `expires_in`, optional `refresh_token`, and optional `scope`. Mark `outputs.access_token.secret = true` and `outputs.refresh_token.secret = true` once the secret-output flag (Workstream A7) ships, so audit and logs scrub them.",
    },
    recipes: [],
    aws_service: null,
    aws_region: null,
  },
];

function main() {
  const raw = readFileSync(TEMPLATES_PATH, "utf8");
  const templates = JSON.parse(raw) as Array<{ slug: string }>;
  const existing = new Set(templates.map((t) => t.slug));
  let added = 0;
  for (const t of NEW_TEMPLATES) {
    if (existing.has(t.slug)) {
      console.log(`skip: ${t.slug} already exists`);
      continue;
    }
    templates.push(t as unknown as { slug: string });
    existing.add(t.slug);
    added += 1;
    console.log(`added: ${t.slug}`);
  }
  // Sort templates by slug to keep diffs reviewable + the order
  // stable across PRs.
  templates.sort((a, b) => a.slug.localeCompare(b.slug));
  writeFileSync(TEMPLATES_PATH, `${JSON.stringify(templates, null, 2)}\n`, "utf8");
  console.log(`done: added ${added} template(s); catalog now has ${templates.length}`);
}

main();
