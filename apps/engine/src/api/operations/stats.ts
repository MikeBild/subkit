import type { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import { BadRequestError, ForbiddenError } from "../../http/errors.ts";
import {
  type AuditGroupDim,
  type AuditOutcome,
  aggregateAudit,
  type StatusClass,
} from "../../stats/aggregate-audit.ts";
import { aggregateExecutions, type ExecutionGroupDim } from "../../stats/aggregate-executions.ts";
import { aggregateQuality } from "../../stats/aggregate-quality.ts";
import { fillGroups, readBucketSeries } from "../../stats/bucket-fill.ts";
import { clampToRetentionHorizon, resolveWindow } from "../stats/bucket-window.ts";
import { EVENT_CLASS_ACTIONS, type EventClass } from "../stats/event-classes.ts";
import {
  ConnectorsStatsQuery,
  ConnectorsStatsResponse,
  EventsStatsQuery,
  EventsStatsResponse,
  ExecutionsStatsQuery,
  ExecutionsStatsResponse,
  StatsQualityQuery,
  StatsQualityResponse,
} from "../stats/schemas.ts";
import { defineOperation, type Operation, type Rejection, reject } from "./index.ts";

type ExecutionsQuery = z.infer<typeof ExecutionsStatsQuery>;
type ConnectorsQuery = z.infer<typeof ConnectorsStatsQuery>;
type EventsQuery = z.infer<typeof EventsStatsQuery>;
type QualityQuery = z.infer<typeof StatsQualityQuery>;

const EXEC_DIMS: readonly string[] = ["workflow_id", "status", "request_source"];
const CONNECTOR_DIMS: readonly string[] = [
  "connector_id",
  "connector_slug",
  "driver",
  "outcome",
  "status_class",
  "method",
];
const EVENT_DIMS: readonly string[] = ["action", "outcome"];
const OUTCOMES: readonly string[] = ["success", "denied", "error"];
const STATUS_CLASSES: readonly string[] = [
  "2xx",
  "3xx",
  "4xx_other",
  "4xx_auth",
  "4xx_rate_limited",
  "5xx",
  "network_error",
  "no_status",
];

export async function settleStats<R>(report: () => Promise<R>): Promise<R | Rejection> {
  try {
    return await report();
  } catch (error) {
    if (error instanceof BadRequestError) return reject.badRequest(error.message, error.details);
    if (error instanceof ForbiddenError) return reject.forbidden(error.message);
    throw error;
  }
}

function allowed<T extends string>(values: string[] | undefined, known: readonly string[]): T[] {
  return (values ?? []).filter((value): value is T => known.includes(value));
}

function nonEmpty<T>(values: T[]): T[] | undefined {
  return values.length > 0 ? values : undefined;
}

async function executionsReport(db: Db, tenantId: string, query: ExecutionsQuery) {
  const win = resolveWindow(query);
  const result = await aggregateExecutions(db, {
    tenantId,
    bucket: win.bucket,
    from: win.from,
    to: win.to,
    tz: win.tz,
    workflowId: query.workflow_id,
    status: query.status,
    requestSource: query.request_source,
    executionMode: query.execution_mode,
    groupBy: allowed<ExecutionGroupDim>(query.group_by, EXEC_DIMS),
  });
  const groups =
    query.fill === "none"
      ? result.groups
      : fillGroups(result.groups, await readBucketSeries(db, win), (ts) => ({
          ts,
          executions: 0,
          duration_ms: { total: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 },
        }));
  return {
    bucket: win.bucket,
    tz: win.tz,
    from: win.from.toISOString(),
    to: win.to.toISOString(),
    ...result,
    groups,
  };
}

async function connectorsReport(db: Db, tenantId: string, query: ConnectorsQuery) {
  const win = await clampToRetentionHorizon(db, tenantId, resolveWindow(query));
  const result = await aggregateAudit(db, {
    tenantId,
    bucket: win.bucket,
    from: win.from,
    to: win.to,
    tz: win.tz,
    actions: [AuditAction.CONNECTOR_INVOKED, AuditAction.MCP_EXTERNAL_TOOL_INVOKED],
    excludeActionDriver: { action: AuditAction.CONNECTOR_INVOKED, driver: "mcp" },
    connectorId: query.connector_id,
    connectorSlug: query.connector_slug,
    driver: query.driver,
    method: query.method,
    outcome: nonEmpty(allowed<AuditOutcome>(query.outcome, OUTCOMES)),
    statusClass: nonEmpty(allowed<StatusClass>(query.status_class, STATUS_CLASSES)),
    groupBy: allowed<AuditGroupDim>(query.group_by, CONNECTOR_DIMS),
    includeEndpoint: query.include_endpoint,
  });
  return {
    bucket: win.bucket,
    tz: win.tz,
    from: win.from.toISOString(),
    to: win.to.toISOString(),
    ...(win.truncated_at ? { truncated_at: win.truncated_at } : {}),
    ...result,
  };
}

async function eventsReport(db: Db, tenantId: string, query: EventsQuery) {
  const win = await clampToRetentionHorizon(db, tenantId, resolveWindow(query));
  const groupBy = allowed<AuditGroupDim>(query.group_by, EVENT_DIMS);
  const result = await aggregateAudit(db, {
    tenantId,
    bucket: win.bucket,
    from: win.from,
    to: win.to,
    tz: win.tz,
    actions: EVENT_CLASS_ACTIONS[query.class as EventClass],
    outcome: nonEmpty(allowed<AuditOutcome>(query.outcome, OUTCOMES)),
    groupBy: groupBy.length > 0 ? groupBy : ["action"],
  });
  return {
    bucket: win.bucket,
    tz: win.tz,
    from: win.from.toISOString(),
    to: win.to.toISOString(),
    ...(win.truncated_at ? { truncated_at: win.truncated_at } : {}),
    ...result,
  };
}

async function qualityReport(db: Db, tenantId: string, query: QualityQuery) {
  const win = resolveWindow(query);
  const result = await aggregateQuality(db, {
    tenantId,
    from: win.from,
    to: win.to,
    workflowId: query.workflow_id,
  });
  return {
    bucket: win.bucket,
    tz: win.tz,
    from: win.from.toISOString(),
    to: win.to.toISOString(),
    ...result,
  };
}

interface StatsRoute<Q, R> {
  readonly id: string;
  readonly path: string;
  readonly summary: string;
  readonly query: z.ZodTypeAny;
  readonly response: z.ZodTypeAny;
  readonly report: (db: Db, tenantId: string, query: Q) => Promise<R>;
}

function statsOperation<Q, R>(route: StatsRoute<Q, R>): Operation<Q, R> {
  return defineOperation<Q, R>({
    id: route.id,
    summary: route.summary,
    permission: "stats:read",
    effect: "read",
    handler: (scope, query) => settleStats(() => route.report(scope.db, scope.tenant_id, query)),
    http: {
      method: "get",
      path: route.path,
      tags: ["Stats"],
      query: route.query,
      response: route.response,
      errors: { 400: "Invalid window" },
      toInput: ({ query }) => query as Q,
      toBody: (report) => report,
    },
  });
}

export const executionsStatsOperation = statsOperation({
  id: "stats.executions",
  path: "/v1/stats/executions",
  summary: "Time-bucketed workflow execution stats (count + duration distribution)",
  query: ExecutionsStatsQuery,
  response: ExecutionsStatsResponse,
  report: executionsReport,
});

export const connectorsStatsOperation = statsOperation({
  id: "stats.connectors",
  path: "/v1/stats/connectors",
  summary: "Time-bucketed connector-call stats (volume + latency + outcome distribution)",
  query: ConnectorsStatsQuery,
  response: ConnectorsStatsResponse,
  report: connectorsReport,
});

export const eventsStatsOperation = statsOperation({
  id: "stats.events",
  path: "/v1/stats/events",
  summary: "Time-bucketed audit-event stats by class (webhooks, chat, self-healing, policy, …)",
  query: EventsStatsQuery,
  response: EventsStatsResponse,
  report: eventsReport,
});

export const qualityStatsOperation = statsOperation({
  id: "stats.quality",
  path: "/v1/stats/quality",
  summary: "Workflow quality: one-shot success, failure reasons, post-repair success",
  query: StatsQualityQuery,
  response: StatsQualityResponse,
  report: qualityReport,
});
