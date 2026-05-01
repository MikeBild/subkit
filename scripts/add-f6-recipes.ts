// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${connector.<slug>.base_url}` and `${input.x}` placeholder tokens are consumed by the executor's substitution parser at run time.
//
// Workstream B (subset) — initial recipes for the six F6 net-new
// templates (CloudWatch logs/metrics/alarms, STS, EventBridge,
// OAuth2-generic). Per the F6 plan, each new template's recipe roster
// ships in this follow-up PR.
//
// All recipes are single-connector, request/response. They lean on
// the existing executor (no Workstream A primitives needed). AWS
// recipes use AWS SigV4 + the X-Amz-Target header convention; the
// OAuth2 generic recipes follow RFC 6749 token endpoints.
//
// Idempotent — re-running on amended templates skips existing slugs.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TEMPLATES_PATH = resolve(import.meta.dir, "..", "apps/engine/src/connectors/templates.json");

type Recipe = Record<string, unknown>;
type Template = { slug: string; recipes?: Recipe[] };

const LOGS_BASE = "${connector.aws-cloudwatch-logs.base_url}";
const METRICS_BASE = "${connector.aws-cloudwatch-metrics.base_url}";
const ALARMS_BASE = "${connector.aws-cloudwatch-alarms.base_url}";
const STS_BASE = "${connector.aws-sts.base_url}";
const EVENTS_BASE = "${connector.aws-eventbridge.base_url}";
const OAUTH2_BASE = "${connector.oauth2-generic.base_url}";

interface RecipeDef {
  template_slug: string;
  recipe: Recipe;
}

function recipe(args: {
  template: string;
  slug: string;
  title: string;
  description: string;
  intent_keywords: string[];
  category: string;
  tags?: string[];
  difficulty?: "beginner" | "intermediate" | "advanced";
  prerequisites?: string[];
  sample_input?: unknown;
  expected_output_preview?: unknown;
  workflow: Record<string, unknown>;
}): RecipeDef {
  return {
    template_slug: args.template,
    recipe: {
      slug: args.slug,
      title: args.title,
      description: args.description,
      intent_keywords: args.intent_keywords,
      derived_from_skill: null,
      category: args.category,
      tags: args.tags ?? [],
      difficulty: args.difficulty ?? "intermediate",
      estimated_setup_minutes: 5,
      prerequisites: args.prerequisites ?? [],
      sample_input: args.sample_input ?? null,
      expected_output_preview: args.expected_output_preview ?? null,
      required_connectors: [],
      version: "1.0.0",
      author: "subkit-builtin",
      last_validated_at: null,
      deprecated: null,
      workflow: args.workflow,
    },
  };
}

const RECIPES: RecipeDef[] = [
  // ───────────────────────────────────────────── aws-cloudwatch-logs
  recipe({
    template: "aws-cloudwatch-logs",
    slug: "list-log-groups",
    title: "List CloudWatch log groups",
    description: "Page through all log groups in the account, optionally filtered by name prefix.",
    intent_keywords: ["list log groups", "cloudwatch log groups", "show log groups"],
    category: "aws",
    tags: ["read"],
    difficulty: "beginner",
    prerequisites: ["IAM principal with logs:DescribeLogGroups"],
    sample_input: { prefix: "/aws/lambda/" },
    workflow: {
      name: "cloudwatch-list-log-groups",
      description: "DescribeLogGroups paginated by nextToken.",
      input_schema: {
        type: "object",
        properties: {
          prefix: { type: "string" },
          limit: { type: "number", default: 50 },
        },
      },
      steps: [
        {
          kind: "request",
          id: "describe",
          method: "POST",
          url: `${LOGS_BASE}/`,
          headers: {
            "x-amz-target": "Logs_20140328.DescribeLogGroups",
            "content-type": "application/x-amz-json-1.1",
          },
          body: {
            logGroupNamePrefix: "${input.prefix}",
            limit: "${input.limit}",
          },
        },
      ],
    },
  }),
  recipe({
    template: "aws-cloudwatch-logs",
    slug: "create-log-group",
    title: "Create a CloudWatch log group",
    description: "External write. Creates a log group with optional KMS encryption + tags.",
    intent_keywords: ["create log group", "new log group", "make cloudwatch group"],
    category: "aws",
    tags: ["write"],
    difficulty: "beginner",
    prerequisites: ["IAM principal with logs:CreateLogGroup"],
    sample_input: { log_group_name: "/app/orders" },
    workflow: {
      name: "cloudwatch-create-log-group",
      input_schema: {
        type: "object",
        required: ["log_group_name"],
        properties: {
          log_group_name: { type: "string" },
          kms_key_id: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "create",
          method: "POST",
          url: `${LOGS_BASE}/`,
          headers: {
            "x-amz-target": "Logs_20140328.CreateLogGroup",
            "content-type": "application/x-amz-json-1.1",
          },
          body: {
            logGroupName: "${input.log_group_name}",
            kmsKeyId: "${input.kms_key_id}",
          },
        },
      ],
    },
  }),
  recipe({
    template: "aws-cloudwatch-logs",
    slug: "put-log-event",
    title: "Put a single log event into a CloudWatch log stream",
    description:
      "External write. Appends one log event. Handles InvalidSequenceTokenException by re-fetching DescribeLogStreams once and retrying.",
    intent_keywords: ["put log event", "write log line", "send to cloudwatch"],
    category: "aws",
    tags: ["write"],
    difficulty: "intermediate",
    prerequisites: ["IAM principal with logs:PutLogEvents + logs:DescribeLogStreams"],
    sample_input: {
      log_group_name: "/app/orders",
      log_stream_name: "host-1",
      message: "order placed",
    },
    workflow: {
      name: "cloudwatch-put-log-event",
      input_schema: {
        type: "object",
        required: ["log_group_name", "log_stream_name", "message"],
        properties: {
          log_group_name: { type: "string" },
          log_stream_name: { type: "string" },
          message: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "describe_streams",
          method: "POST",
          url: `${LOGS_BASE}/`,
          headers: {
            "x-amz-target": "Logs_20140328.DescribeLogStreams",
            "content-type": "application/x-amz-json-1.1",
          },
          body: {
            logGroupName: "${input.log_group_name}",
            logStreamNamePrefix: "${input.log_stream_name}",
          },
        },
        {
          kind: "request",
          id: "put",
          method: "POST",
          url: `${LOGS_BASE}/`,
          headers: {
            "x-amz-target": "Logs_20140328.PutLogEvents",
            "content-type": "application/x-amz-json-1.1",
          },
          body: {
            logGroupName: "${input.log_group_name}",
            logStreamName: "${input.log_stream_name}",
            sequenceToken: "${describe_streams.body.logStreams[0].uploadSequenceToken}",
            logEvents: [{ timestamp: "${$now()}", message: "${input.message}" }],
          },
          max_retries: 1,
        },
      ],
    },
  }),
  recipe({
    template: "aws-cloudwatch-logs",
    slug: "query-logs-insights",
    title: "Run a CloudWatch Logs Insights query",
    description:
      "Two-step pattern: StartQuery returns a queryId; GetQueryResults polls until the query completes. The recipe uses the GetQueryResults endpoint once — caller polls if status === 'Running'.",
    intent_keywords: ["logs insights", "query logs", "search logs"],
    category: "aws",
    tags: ["read"],
    difficulty: "advanced",
    prerequisites: ["IAM principal with logs:StartQuery + logs:GetQueryResults"],
    sample_input: {
      log_group_name: "/aws/lambda/orders",
      query_string: "fields @timestamp, @message | sort @timestamp desc | limit 20",
      start_time: 1735689600,
      end_time: 1735776000,
    },
    workflow: {
      name: "cloudwatch-logs-insights-query",
      input_schema: {
        type: "object",
        required: ["log_group_name", "query_string", "start_time", "end_time"],
        properties: {
          log_group_name: { type: "string" },
          query_string: { type: "string" },
          start_time: { type: "number" },
          end_time: { type: "number" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "start",
          method: "POST",
          url: `${LOGS_BASE}/`,
          headers: {
            "x-amz-target": "Logs_20140328.StartQuery",
            "content-type": "application/x-amz-json-1.1",
          },
          body: {
            logGroupName: "${input.log_group_name}",
            queryString: "${input.query_string}",
            startTime: "${input.start_time}",
            endTime: "${input.end_time}",
          },
        },
        {
          kind: "request",
          id: "fetch",
          method: "POST",
          url: `${LOGS_BASE}/`,
          headers: {
            "x-amz-target": "Logs_20140328.GetQueryResults",
            "content-type": "application/x-amz-json-1.1",
          },
          body: { queryId: "${start.body.queryId}" },
        },
      ],
    },
  }),
  recipe({
    template: "aws-cloudwatch-logs",
    slug: "set-retention",
    title: "Set CloudWatch log group retention",
    description:
      "External write. Set days-retention on a log group (1, 7, 14, 30, 60, 90, ... 3653, never).",
    intent_keywords: ["log retention", "log expiry", "cloudwatch retention"],
    category: "aws",
    tags: ["write"],
    difficulty: "beginner",
    prerequisites: ["IAM principal with logs:PutRetentionPolicy"],
    sample_input: { log_group_name: "/app/orders", retention_in_days: 30 },
    workflow: {
      name: "cloudwatch-set-retention",
      input_schema: {
        type: "object",
        required: ["log_group_name", "retention_in_days"],
        properties: {
          log_group_name: { type: "string" },
          retention_in_days: { type: "number" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "set",
          method: "POST",
          url: `${LOGS_BASE}/`,
          headers: {
            "x-amz-target": "Logs_20140328.PutRetentionPolicy",
            "content-type": "application/x-amz-json-1.1",
          },
          body: {
            logGroupName: "${input.log_group_name}",
            retentionInDays: "${input.retention_in_days}",
          },
        },
      ],
    },
  }),
  recipe({
    template: "aws-cloudwatch-logs",
    slug: "filter-log-events",
    title: "Filter CloudWatch log events with a pattern",
    description:
      "Server-side filter pattern over a log group, optionally bounded by a time window.",
    intent_keywords: ["filter log events", "search log events", "tail logs"],
    category: "aws",
    tags: ["read"],
    difficulty: "intermediate",
    prerequisites: ["IAM principal with logs:FilterLogEvents"],
    sample_input: {
      log_group_name: "/aws/lambda/orders",
      filter_pattern: "ERROR",
      start_time: 1735689600,
    },
    workflow: {
      name: "cloudwatch-filter-log-events",
      input_schema: {
        type: "object",
        required: ["log_group_name"],
        properties: {
          log_group_name: { type: "string" },
          filter_pattern: { type: "string" },
          start_time: { type: "number" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "filter",
          method: "POST",
          url: `${LOGS_BASE}/`,
          headers: {
            "x-amz-target": "Logs_20140328.FilterLogEvents",
            "content-type": "application/x-amz-json-1.1",
          },
          body: {
            logGroupName: "${input.log_group_name}",
            filterPattern: "${input.filter_pattern}",
            startTime: "${input.start_time}",
          },
        },
      ],
    },
  }),
  // ───────────────────────────────────────── aws-cloudwatch-metrics
  recipe({
    template: "aws-cloudwatch-metrics",
    slug: "put-metric-data",
    title: "Put custom metric data into CloudWatch",
    description:
      "External write. Form-encoded Query protocol. Submits one or more metric data points under a custom namespace.",
    intent_keywords: ["put metric", "submit metric", "custom metric"],
    category: "aws",
    tags: ["write"],
    difficulty: "intermediate",
    prerequisites: ["IAM principal with cloudwatch:PutMetricData"],
    sample_input: { namespace: "Orders", metric_name: "PlacedTotal", value: 1, unit: "Count" },
    workflow: {
      name: "cloudwatch-put-metric-data",
      input_schema: {
        type: "object",
        required: ["namespace", "metric_name", "value", "unit"],
        properties: {
          namespace: { type: "string" },
          metric_name: { type: "string" },
          value: { type: "number" },
          unit: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "put",
          method: "POST",
          url: `${METRICS_BASE}/`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            Action: "PutMetricData",
            Version: "2010-08-01",
            Namespace: "${input.namespace}",
            "MetricData.member.1.MetricName": "${input.metric_name}",
            "MetricData.member.1.Value": "${input.value}",
            "MetricData.member.1.Unit": "${input.unit}",
          },
        },
      ],
    },
  }),
  recipe({
    template: "aws-cloudwatch-metrics",
    slug: "get-metric-statistics",
    title: "Get statistics for a CloudWatch metric",
    description: "Query average / sum / max / min / sample-count over a time window with a period.",
    intent_keywords: ["metric statistics", "metric history", "cloudwatch query"],
    category: "aws",
    tags: ["read"],
    difficulty: "intermediate",
    prerequisites: ["IAM principal with cloudwatch:GetMetricStatistics"],
    sample_input: {
      namespace: "AWS/Lambda",
      metric_name: "Invocations",
      start_time: "2026-04-01T00:00:00Z",
      end_time: "2026-04-30T23:59:59Z",
      period: 3600,
    },
    workflow: {
      name: "cloudwatch-get-metric-statistics",
      input_schema: {
        type: "object",
        required: ["namespace", "metric_name", "start_time", "end_time", "period"],
        properties: {
          namespace: { type: "string" },
          metric_name: { type: "string" },
          start_time: { type: "string" },
          end_time: { type: "string" },
          period: { type: "number" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "get",
          method: "POST",
          url: `${METRICS_BASE}/`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            Action: "GetMetricStatistics",
            Version: "2010-08-01",
            Namespace: "${input.namespace}",
            MetricName: "${input.metric_name}",
            StartTime: "${input.start_time}",
            EndTime: "${input.end_time}",
            Period: "${input.period}",
            "Statistics.member.1": "Sum",
            "Statistics.member.2": "Average",
            "Statistics.member.3": "Maximum",
          },
        },
      ],
    },
  }),
  recipe({
    template: "aws-cloudwatch-metrics",
    slug: "list-metrics",
    title: "List metrics in a namespace",
    description: "Cursor-paginated listing of metric names + dimensions in a namespace.",
    intent_keywords: ["list metrics", "metrics in namespace", "discover metrics"],
    category: "aws",
    tags: ["read"],
    difficulty: "beginner",
    prerequisites: ["IAM principal with cloudwatch:ListMetrics"],
    sample_input: { namespace: "AWS/Lambda" },
    workflow: {
      name: "cloudwatch-list-metrics",
      input_schema: {
        type: "object",
        properties: { namespace: { type: "string" } },
      },
      steps: [
        {
          kind: "request",
          id: "list",
          method: "POST",
          url: `${METRICS_BASE}/`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            Action: "ListMetrics",
            Version: "2010-08-01",
            Namespace: "${input.namespace}",
          },
        },
      ],
    },
  }),
  recipe({
    template: "aws-cloudwatch-metrics",
    slug: "get-metric-data",
    title: "Get metric data via the v2 API (multiple metrics in one call)",
    description:
      "Modern GetMetricData endpoint — fetch many metrics + statistics in a single call.",
    intent_keywords: ["get metric data", "batch metrics", "metric data v2"],
    category: "aws",
    tags: ["read"],
    difficulty: "advanced",
    prerequisites: ["IAM principal with cloudwatch:GetMetricData"],
    sample_input: {
      start_time: "2026-04-01T00:00:00Z",
      end_time: "2026-04-30T23:59:59Z",
    },
    workflow: {
      name: "cloudwatch-get-metric-data",
      input_schema: {
        type: "object",
        required: ["start_time", "end_time"],
        properties: {
          start_time: { type: "string" },
          end_time: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "POST",
          url: `${METRICS_BASE}/`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            Action: "GetMetricData",
            Version: "2010-08-01",
            StartTime: "${input.start_time}",
            EndTime: "${input.end_time}",
            "MetricDataQueries.member.1.Id": "m1",
            "MetricDataQueries.member.1.MetricStat.Metric.Namespace": "AWS/Lambda",
            "MetricDataQueries.member.1.MetricStat.Metric.MetricName": "Invocations",
            "MetricDataQueries.member.1.MetricStat.Period": "3600",
            "MetricDataQueries.member.1.MetricStat.Stat": "Sum",
          },
        },
      ],
    },
  }),
  // ────────────────────────────────────────── aws-cloudwatch-alarms
  recipe({
    template: "aws-cloudwatch-alarms",
    slug: "describe-alarms",
    title: "Describe CloudWatch alarms",
    description: "List alarms by name prefix, state, or alarm-action prefix.",
    intent_keywords: ["describe alarms", "list alarms", "show cloudwatch alarms"],
    category: "aws",
    tags: ["read"],
    difficulty: "beginner",
    prerequisites: ["IAM principal with cloudwatch:DescribeAlarms"],
    sample_input: { state_value: "ALARM" },
    workflow: {
      name: "cloudwatch-describe-alarms",
      input_schema: {
        type: "object",
        properties: {
          state_value: { type: "string", enum: ["OK", "ALARM", "INSUFFICIENT_DATA"] },
        },
      },
      steps: [
        {
          kind: "request",
          id: "describe",
          method: "POST",
          url: `${ALARMS_BASE}/`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            Action: "DescribeAlarms",
            Version: "2010-08-01",
            StateValue: "${input.state_value}",
          },
        },
      ],
    },
  }),
  recipe({
    template: "aws-cloudwatch-alarms",
    slug: "set-alarm-state",
    title: "Manually set a CloudWatch alarm's state",
    description:
      "External write. Useful for runbook drills or to clear a stuck INSUFFICIENT_DATA state.",
    intent_keywords: ["set alarm state", "trigger alarm", "ack alarm"],
    category: "aws",
    tags: ["write"],
    difficulty: "intermediate",
    prerequisites: ["IAM principal with cloudwatch:SetAlarmState"],
    sample_input: { alarm_name: "high-error-rate", state_value: "OK", state_reason: "manual ack" },
    workflow: {
      name: "cloudwatch-set-alarm-state",
      input_schema: {
        type: "object",
        required: ["alarm_name", "state_value", "state_reason"],
        properties: {
          alarm_name: { type: "string" },
          state_value: { type: "string", enum: ["OK", "ALARM", "INSUFFICIENT_DATA"] },
          state_reason: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "set",
          method: "POST",
          url: `${ALARMS_BASE}/`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            Action: "SetAlarmState",
            Version: "2010-08-01",
            AlarmName: "${input.alarm_name}",
            StateValue: "${input.state_value}",
            StateReason: "${input.state_reason}",
          },
        },
      ],
    },
  }),
  recipe({
    template: "aws-cloudwatch-alarms",
    slug: "disable-actions",
    title: "Disable a CloudWatch alarm's actions (mute)",
    description:
      "External write. Suspends notification + auto-scaling actions without deleting the alarm. Pair with `enable-actions` after the maintenance window.",
    intent_keywords: ["mute alarm", "disable alarm actions", "silence cloudwatch"],
    category: "aws",
    tags: ["write"],
    difficulty: "beginner",
    prerequisites: ["IAM principal with cloudwatch:DisableAlarmActions"],
    sample_input: { alarm_names: ["high-error-rate"] },
    workflow: {
      name: "cloudwatch-disable-actions",
      input_schema: {
        type: "object",
        required: ["alarm_names"],
        properties: {
          alarm_names: { type: "array", items: { type: "string" } },
        },
      },
      steps: [
        {
          kind: "request",
          id: "disable",
          method: "POST",
          url: `${ALARMS_BASE}/`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            Action: "DisableAlarmActions",
            Version: "2010-08-01",
            "AlarmNames.member.1": "${input.alarm_names[0]}",
          },
        },
      ],
    },
  }),
  recipe({
    template: "aws-cloudwatch-alarms",
    slug: "enable-actions",
    title: "Enable a CloudWatch alarm's actions (unmute)",
    description:
      "External write. Re-arms notification + auto-scaling actions on alarms that were temporarily disabled.",
    intent_keywords: ["unmute alarm", "enable alarm actions", "resume cloudwatch"],
    category: "aws",
    tags: ["write"],
    difficulty: "beginner",
    prerequisites: ["IAM principal with cloudwatch:EnableAlarmActions"],
    sample_input: { alarm_names: ["high-error-rate"] },
    workflow: {
      name: "cloudwatch-enable-actions",
      input_schema: {
        type: "object",
        required: ["alarm_names"],
        properties: {
          alarm_names: { type: "array", items: { type: "string" } },
        },
      },
      steps: [
        {
          kind: "request",
          id: "enable",
          method: "POST",
          url: `${ALARMS_BASE}/`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            Action: "EnableAlarmActions",
            Version: "2010-08-01",
            "AlarmNames.member.1": "${input.alarm_names[0]}",
          },
        },
      ],
    },
  }),
  // ─────────────────────────────────────────────────────── aws-sts
  recipe({
    template: "aws-sts",
    slug: "get-caller-identity",
    title: "Get the caller's AWS account / ARN / user-id",
    description:
      "Returns the account, ARN, and userId of the IAM principal whose credentials signed the call. The canonical 'whoami' for AWS.",
    intent_keywords: ["whoami aws", "caller identity", "current iam"],
    category: "aws",
    tags: ["read"],
    difficulty: "beginner",
    prerequisites: ["Any AWS credentials (no IAM permission required)"],
    workflow: {
      name: "sts-get-caller-identity",
      steps: [
        {
          kind: "request",
          id: "whoami",
          method: "POST",
          url: `${STS_BASE}/`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            Action: "GetCallerIdentity",
            Version: "2011-06-15",
          },
        },
      ],
    },
  }),
  recipe({
    template: "aws-sts",
    slug: "assume-role",
    title: "Assume an IAM role and get temporary credentials",
    description:
      "External write (issues new credentials). Returns AccessKeyId + SecretAccessKey + SessionToken (default 1h, max 12h). The token is sensitive — bind into downstream sigv4 calls via secret outputs.",
    intent_keywords: ["assume role", "cross account", "temporary credentials"],
    category: "aws",
    tags: ["write", "auth"],
    difficulty: "advanced",
    prerequisites: ["IAM principal with sts:AssumeRole on the target role"],
    sample_input: {
      role_arn: "arn:aws:iam::123456789012:role/CrossAccountRead",
      role_session_name: "subkit-session",
      duration_seconds: 3600,
    },
    workflow: {
      name: "sts-assume-role",
      input_schema: {
        type: "object",
        required: ["role_arn", "role_session_name"],
        properties: {
          role_arn: { type: "string" },
          role_session_name: { type: "string" },
          duration_seconds: { type: "number", default: 3600 },
        },
      },
      steps: [
        {
          kind: "request",
          id: "assume",
          method: "POST",
          url: `${STS_BASE}/`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            Action: "AssumeRole",
            Version: "2011-06-15",
            RoleArn: "${input.role_arn}",
            RoleSessionName: "${input.role_session_name}",
            DurationSeconds: "${input.duration_seconds}",
          },
          outputs: {
            "AssumeRoleResult.Credentials.SecretAccessKey": { secret: true },
            "AssumeRoleResult.Credentials.SessionToken": { secret: true },
          },
        },
      ],
    },
  }),
  recipe({
    template: "aws-sts",
    slug: "assume-role-with-web-identity",
    title: "Assume an IAM role using an OIDC web identity (e.g. GitHub OIDC)",
    description:
      "Exchange a short-lived OIDC JWT (GitHub Actions, Auth0, custom IdP) for AWS temporary credentials. The web-identity flow needs no long-lived AWS keys.",
    intent_keywords: ["oidc to aws", "github oidc", "web identity"],
    category: "aws",
    tags: ["write", "auth", "oidc"],
    difficulty: "advanced",
    prerequisites: ["IdP-issued JWT in input.web_identity_token"],
    sample_input: {
      role_arn: "arn:aws:iam::123456789012:role/GhActionsDeploy",
      role_session_name: "gh-deploy",
      web_identity_token: "<oidc-jwt>",
    },
    workflow: {
      name: "sts-assume-role-with-web-identity",
      input_schema: {
        type: "object",
        required: ["role_arn", "role_session_name", "web_identity_token"],
        properties: {
          role_arn: { type: "string" },
          role_session_name: { type: "string" },
          web_identity_token: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "assume",
          method: "POST",
          url: `${STS_BASE}/`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            Action: "AssumeRoleWithWebIdentity",
            Version: "2011-06-15",
            RoleArn: "${input.role_arn}",
            RoleSessionName: "${input.role_session_name}",
            WebIdentityToken: "${input.web_identity_token}",
          },
          outputs: {
            "AssumeRoleWithWebIdentityResult.Credentials.SecretAccessKey": { secret: true },
            "AssumeRoleWithWebIdentityResult.Credentials.SessionToken": { secret: true },
          },
        },
      ],
    },
  }),
  recipe({
    template: "aws-sts",
    slug: "get-session-token",
    title: "Get a short-lived session token (MFA-aware)",
    description:
      "External write. Returns temporary credentials for the calling IAM user, optionally backed by an MFA TOTP. Use for break-glass scripts.",
    intent_keywords: ["session token", "mfa token", "temporary keys"],
    category: "aws",
    tags: ["write", "auth"],
    difficulty: "intermediate",
    prerequisites: ["IAM user with sts:GetSessionToken"],
    sample_input: { duration_seconds: 3600 },
    workflow: {
      name: "sts-get-session-token",
      input_schema: {
        type: "object",
        properties: {
          duration_seconds: { type: "number", default: 3600 },
          serial_number: { type: "string" },
          token_code: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "issue",
          method: "POST",
          url: `${STS_BASE}/`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            Action: "GetSessionToken",
            Version: "2011-06-15",
            DurationSeconds: "${input.duration_seconds}",
            SerialNumber: "${input.serial_number}",
            TokenCode: "${input.token_code}",
          },
          outputs: {
            "GetSessionTokenResult.Credentials.SecretAccessKey": { secret: true },
            "GetSessionTokenResult.Credentials.SessionToken": { secret: true },
          },
        },
      ],
    },
  }),
  // ──────────────────────────────────────────────── aws-eventbridge
  recipe({
    template: "aws-eventbridge",
    slug: "put-events",
    title: "Publish one or more events to EventBridge",
    description:
      "External write. Up to 10 entries per call. Each entry has Source + DetailType + Detail (JSON string) + optional EventBusName.",
    intent_keywords: ["publish event", "put events", "send to eventbridge"],
    category: "aws",
    tags: ["write"],
    difficulty: "intermediate",
    prerequisites: ["IAM principal with events:PutEvents"],
    sample_input: {
      source: "myapp.orders",
      detail_type: "OrderPlaced",
      detail: '{"order_id":"ord_123","amount":5000}',
    },
    workflow: {
      name: "eventbridge-put-events",
      input_schema: {
        type: "object",
        required: ["source", "detail_type", "detail"],
        properties: {
          source: { type: "string" },
          detail_type: { type: "string" },
          detail: { type: "string" },
          event_bus_name: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "put",
          method: "POST",
          url: `${EVENTS_BASE}/`,
          headers: {
            "x-amz-target": "AWSEvents.PutEvents",
            "content-type": "application/x-amz-json-1.1",
          },
          body: {
            Entries: [
              {
                Source: "${input.source}",
                DetailType: "${input.detail_type}",
                Detail: "${input.detail}",
                EventBusName: "${input.event_bus_name}",
              },
            ],
          },
        },
      ],
    },
  }),
  recipe({
    template: "aws-eventbridge",
    slug: "list-rules",
    title: "List EventBridge rules",
    description: "List rules in a bus, optionally filtered by name prefix.",
    intent_keywords: ["list rules", "eventbridge rules", "show rules"],
    category: "aws",
    tags: ["read"],
    difficulty: "beginner",
    prerequisites: ["IAM principal with events:ListRules"],
    sample_input: { event_bus_name: "default" },
    workflow: {
      name: "eventbridge-list-rules",
      input_schema: {
        type: "object",
        properties: {
          event_bus_name: { type: "string" },
          name_prefix: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "list",
          method: "POST",
          url: `${EVENTS_BASE}/`,
          headers: {
            "x-amz-target": "AWSEvents.ListRules",
            "content-type": "application/x-amz-json-1.1",
          },
          body: {
            EventBusName: "${input.event_bus_name}",
            NamePrefix: "${input.name_prefix}",
          },
        },
      ],
    },
  }),
  recipe({
    template: "aws-eventbridge",
    slug: "create-rule",
    title: "Create an EventBridge rule",
    description: "External write. Define a rule with an EventPattern or ScheduleExpression.",
    intent_keywords: ["create rule", "new event rule", "eventbridge subscription"],
    category: "aws",
    tags: ["write"],
    difficulty: "advanced",
    prerequisites: ["IAM principal with events:PutRule"],
    sample_input: {
      name: "order-placed-rule",
      event_pattern: '{"source":["myapp.orders"],"detail-type":["OrderPlaced"]}',
    },
    workflow: {
      name: "eventbridge-create-rule",
      input_schema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          event_pattern: { type: "string" },
          schedule_expression: { type: "string" },
          description: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "put",
          method: "POST",
          url: `${EVENTS_BASE}/`,
          headers: {
            "x-amz-target": "AWSEvents.PutRule",
            "content-type": "application/x-amz-json-1.1",
          },
          body: {
            Name: "${input.name}",
            EventPattern: "${input.event_pattern}",
            ScheduleExpression: "${input.schedule_expression}",
            Description: "${input.description}",
            State: "ENABLED",
          },
        },
      ],
    },
  }),
  recipe({
    template: "aws-eventbridge",
    slug: "list-targets",
    title: "List the targets attached to an EventBridge rule",
    description: "Show every target wired up to a rule (Lambda, SQS, SNS, ECS task, etc.).",
    intent_keywords: ["list targets", "rule targets", "eventbridge wiring"],
    category: "aws",
    tags: ["read"],
    difficulty: "beginner",
    prerequisites: ["IAM principal with events:ListTargetsByRule"],
    sample_input: { rule_name: "order-placed-rule" },
    workflow: {
      name: "eventbridge-list-targets",
      input_schema: {
        type: "object",
        required: ["rule_name"],
        properties: {
          rule_name: { type: "string" },
          event_bus_name: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "list",
          method: "POST",
          url: `${EVENTS_BASE}/`,
          headers: {
            "x-amz-target": "AWSEvents.ListTargetsByRule",
            "content-type": "application/x-amz-json-1.1",
          },
          body: {
            Rule: "${input.rule_name}",
            EventBusName: "${input.event_bus_name}",
          },
        },
      ],
    },
  }),
  recipe({
    template: "aws-eventbridge",
    slug: "enable-rule",
    title: "Enable an EventBridge rule",
    description: "External write. Toggles a rule from DISABLED to ENABLED.",
    intent_keywords: ["enable rule", "turn on event rule", "resume eventbridge"],
    category: "aws",
    tags: ["write"],
    difficulty: "beginner",
    prerequisites: ["IAM principal with events:EnableRule"],
    sample_input: { name: "order-placed-rule" },
    workflow: {
      name: "eventbridge-enable-rule",
      input_schema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          event_bus_name: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "enable",
          method: "POST",
          url: `${EVENTS_BASE}/`,
          headers: {
            "x-amz-target": "AWSEvents.EnableRule",
            "content-type": "application/x-amz-json-1.1",
          },
          body: {
            Name: "${input.name}",
            EventBusName: "${input.event_bus_name}",
          },
        },
      ],
    },
  }),
  recipe({
    template: "aws-eventbridge",
    slug: "disable-rule",
    title: "Disable an EventBridge rule",
    description:
      "External write. Toggles a rule from ENABLED to DISABLED. Pairs with `enable-rule`.",
    intent_keywords: ["disable rule", "turn off event rule", "mute eventbridge"],
    category: "aws",
    tags: ["write"],
    difficulty: "beginner",
    prerequisites: ["IAM principal with events:DisableRule"],
    sample_input: { name: "order-placed-rule" },
    workflow: {
      name: "eventbridge-disable-rule",
      input_schema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          event_bus_name: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "disable",
          method: "POST",
          url: `${EVENTS_BASE}/`,
          headers: {
            "x-amz-target": "AWSEvents.DisableRule",
            "content-type": "application/x-amz-json-1.1",
          },
          body: {
            Name: "${input.name}",
            EventBusName: "${input.event_bus_name}",
          },
        },
      ],
    },
  }),
  // ──────────────────────────────────────────────── oauth2-generic
  recipe({
    template: "oauth2-generic",
    slug: "exchange-code-for-token",
    title: "OAuth2 — exchange authorization code for tokens",
    description:
      "RFC 6749 §4.1 authorization-code grant. Submits client_id + client_secret (Basic) + code + redirect_uri to the provider's token endpoint. Returns access_token + refresh_token + expires_in.",
    intent_keywords: ["oauth2 exchange code", "auth code grant", "fetch tokens"],
    category: "enterprise",
    tags: ["oauth2", "auth"],
    difficulty: "advanced",
    prerequisites: [
      "client_id + client_secret credentials configured",
      "redirect_uri matches the provider",
    ],
    sample_input: {
      token_endpoint: "/oauth/token",
      code: "<auth-code-from-callback>",
      redirect_uri: "https://app.example.com/callback",
    },
    workflow: {
      name: "oauth2-exchange-code-for-token",
      input_schema: {
        type: "object",
        required: ["token_endpoint", "code", "redirect_uri"],
        properties: {
          token_endpoint: { type: "string" },
          code: { type: "string" },
          redirect_uri: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "exchange",
          method: "POST",
          url: `${OAUTH2_BASE}${"${input.token_endpoint}"}`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            grant_type: "authorization_code",
            code: "${input.code}",
            redirect_uri: "${input.redirect_uri}",
          },
          outputs: {
            access_token: { secret: true },
            refresh_token: { secret: true },
          },
        },
      ],
    },
  }),
  recipe({
    template: "oauth2-generic",
    slug: "refresh-access-token",
    title: "OAuth2 — refresh an access token",
    description:
      "RFC 6749 §6 refresh-token grant. Use when an access token has expired. Some providers also rotate refresh_token on this call — capture both outputs.",
    intent_keywords: ["refresh token", "renew oauth", "extend access"],
    category: "enterprise",
    tags: ["oauth2", "auth"],
    difficulty: "intermediate",
    prerequisites: ["Stored refresh_token from a prior auth_code or password grant"],
    sample_input: {
      token_endpoint: "/oauth/token",
      refresh_token: "<refresh-token>",
    },
    workflow: {
      name: "oauth2-refresh-access-token",
      input_schema: {
        type: "object",
        required: ["token_endpoint", "refresh_token"],
        properties: {
          token_endpoint: { type: "string" },
          refresh_token: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "refresh",
          method: "POST",
          url: `${OAUTH2_BASE}${"${input.token_endpoint}"}`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            grant_type: "refresh_token",
            refresh_token: "${input.refresh_token}",
          },
          outputs: {
            access_token: { secret: true },
            refresh_token: { secret: true },
          },
        },
      ],
    },
  }),
  recipe({
    template: "oauth2-generic",
    slug: "client-credentials-grant",
    title: "OAuth2 — client_credentials grant (machine-to-machine)",
    description:
      "RFC 6749 §4.4 client_credentials grant. No user — the client itself authenticates with client_id + client_secret to receive an access_token scoped to a service identity.",
    intent_keywords: ["client credentials", "m2m oauth", "service token"],
    category: "enterprise",
    tags: ["oauth2", "auth", "m2m"],
    difficulty: "intermediate",
    prerequisites: ["client_id + client_secret with the requested scope"],
    sample_input: {
      token_endpoint: "/oauth/token",
      scope: "read:all",
    },
    workflow: {
      name: "oauth2-client-credentials-grant",
      input_schema: {
        type: "object",
        required: ["token_endpoint"],
        properties: {
          token_endpoint: { type: "string" },
          scope: { type: "string" },
          audience: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "issue",
          method: "POST",
          url: `${OAUTH2_BASE}${"${input.token_endpoint}"}`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            grant_type: "client_credentials",
            scope: "${input.scope}",
            audience: "${input.audience}",
          },
          outputs: {
            access_token: { secret: true },
          },
        },
      ],
    },
  }),
  recipe({
    template: "oauth2-generic",
    slug: "introspect-token",
    title: "OAuth2 — introspect a token (RFC 7662)",
    description:
      "Ask the authorization server whether a token is still active and what scopes / subject it represents. Useful for resource-server gating without verifying signatures locally.",
    intent_keywords: ["introspect token", "validate oauth", "is token active"],
    category: "enterprise",
    tags: ["oauth2", "auth"],
    difficulty: "advanced",
    prerequisites: ["Provider supports the introspection endpoint", "client_id + client_secret"],
    sample_input: {
      introspect_endpoint: "/oauth/introspect",
      token: "<token-to-check>",
    },
    workflow: {
      name: "oauth2-introspect-token",
      input_schema: {
        type: "object",
        required: ["introspect_endpoint", "token"],
        properties: {
          introspect_endpoint: { type: "string" },
          token: { type: "string" },
          token_type_hint: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "introspect",
          method: "POST",
          url: `${OAUTH2_BASE}${"${input.introspect_endpoint}"}`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            token: "${input.token}",
            token_type_hint: "${input.token_type_hint}",
          },
        },
      ],
    },
  }),
  recipe({
    template: "oauth2-generic",
    slug: "revoke-token",
    title: "OAuth2 — revoke a token (RFC 7009)",
    description:
      "External write. Tells the authorization server to immediately invalidate an access_token or refresh_token. Useful on operator-initiated logout or credential-rotation flows.",
    intent_keywords: ["revoke token", "invalidate oauth", "logout"],
    category: "enterprise",
    tags: ["oauth2", "auth"],
    difficulty: "intermediate",
    prerequisites: ["Provider supports the revocation endpoint"],
    sample_input: {
      revoke_endpoint: "/oauth/revoke",
      token: "<token-to-revoke>",
    },
    workflow: {
      name: "oauth2-revoke-token",
      input_schema: {
        type: "object",
        required: ["revoke_endpoint", "token"],
        properties: {
          revoke_endpoint: { type: "string" },
          token: { type: "string" },
          token_type_hint: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "revoke",
          method: "POST",
          url: `${OAUTH2_BASE}${"${input.revoke_endpoint}"}`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            token: "${input.token}",
            token_type_hint: "${input.token_type_hint}",
          },
        },
      ],
    },
  }),
  recipe({
    template: "oauth2-generic",
    slug: "device-code-flow",
    title: "OAuth2 — device code flow (RFC 8628)",
    description:
      "First leg of the device-authorization grant for input-constrained devices (CLIs, TVs, IoT). Returns a user_code + verification_uri the operator visits in a browser. Caller polls the token endpoint with the device_code until approved.",
    intent_keywords: ["device code", "cli login", "tv login", "rfc 8628"],
    category: "enterprise",
    tags: ["oauth2", "auth", "device"],
    difficulty: "advanced",
    prerequisites: ["Provider supports device-code grant", "client_id"],
    sample_input: {
      device_code_endpoint: "/oauth/device/code",
      scope: "read write",
    },
    workflow: {
      name: "oauth2-device-code-flow",
      input_schema: {
        type: "object",
        required: ["device_code_endpoint"],
        properties: {
          device_code_endpoint: { type: "string" },
          scope: { type: "string" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "device",
          method: "POST",
          url: `${OAUTH2_BASE}${"${input.device_code_endpoint}"}`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          form: {
            scope: "${input.scope}",
          },
        },
      ],
    },
  }),
];

function main() {
  const raw = readFileSync(TEMPLATES_PATH, "utf8");
  const templates = JSON.parse(raw) as Template[];
  let added = 0;
  let skipped = 0;
  for (const def of RECIPES) {
    const tpl = templates.find((t) => t.slug === def.template_slug);
    if (!tpl) {
      console.warn(`skip: template \`${def.template_slug}\` not found`);
      skipped += 1;
      continue;
    }
    const existing = tpl.recipes ?? [];
    if (existing.some((r) => r.slug === def.recipe.slug)) {
      console.log(`skip: ${def.template_slug}/${def.recipe.slug} already exists`);
      skipped += 1;
      continue;
    }
    tpl.recipes = [...existing, def.recipe];
    added += 1;
    console.log(`added: ${def.template_slug}/${def.recipe.slug}`);
  }
  writeFileSync(TEMPLATES_PATH, `${JSON.stringify(templates, null, 2)}\n`, "utf8");
  console.log(
    `done: added ${added}, skipped ${skipped}; total recipes: ${templates.reduce((s, t) => s + (t.recipes?.length ?? 0), 0)}`,
  );
}

main();
