import type { z } from "@hono/zod-openapi";
import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { BadRequestError } from "../../http/errors.ts";
import { type ResolvedWindow, resolveWindow } from "../../http/routes/stats/bucket-window.ts";
import { UsageStatsQuery, UsageStatsResponse } from "../../http/routes/stats/schemas.ts";
import {
  aggregateUsage,
  USAGE_GROUP_DIMS,
  type UsageGroupDim,
} from "../../stats/aggregate-usage.ts";
import { TRAFFIC_CLASSES, type TrafficClass, type UsageSurface } from "../../stats/usage-events.ts";
import { now } from "../../utils/clock.ts";
import { defineOperation, type Operation, reject } from "./index.ts";

type UsageQuery = z.infer<typeof UsageStatsQuery>;
type UsageReport = Awaited<ReturnType<typeof buildReport>>;

function validatedTraffic(values: string[] | undefined): TrafficClass[] {
  const requested = values?.length ? values : ["organic"];
  if (requested.some((value) => !(TRAFFIC_CLASSES as readonly string[]).includes(value))) {
    throw new BadRequestError(`traffic_class must contain only: ${TRAFFIC_CLASSES.join(", ")}`, {
      reason: "traffic_class_invalid",
    });
  }
  return requested as TrafficClass[];
}

function validatedGroups(values: string[] | undefined): UsageGroupDim[] {
  const requested = values ?? [];
  if (requested.length > 2) {
    throw new BadRequestError("group_by accepts at most two dimensions", {
      reason: "group_by_too_many",
    });
  }
  if (requested.some((value) => !(USAGE_GROUP_DIMS as readonly string[]).includes(value))) {
    throw new BadRequestError(`group_by must contain only: ${USAGE_GROUP_DIMS.join(", ")}`, {
      reason: "group_by_invalid",
    });
  }
  return requested as UsageGroupDim[];
}

function retentionWindow(win: ResolvedWindow, retentionDays: number): ResolvedWindow {
  const cutoff = new Date(now() - retentionDays * 86_400_000);
  if (win.from >= cutoff) return win;
  if (win.to <= cutoff) {
    throw new BadRequestError(
      `requested window ends before the ${retentionDays}-day usage retention horizon`,
      { reason: "from_before_retention_horizon" },
    );
  }
  return { ...win, from: cutoff, truncated_at: cutoff.toISOString() };
}

async function buildReport(db: Db, tenantId: string, surface: UsageSurface, query: UsageQuery) {
  const usageConfig = getConfig().observability.usage;
  const win = retentionWindow(resolveWindow(query), usageConfig.retention_days);
  const trafficClass = validatedTraffic(query.traffic_class);
  const result = await aggregateUsage(db, {
    tenantId,
    surface,
    bucket: win.bucket,
    from: win.from,
    to: win.to,
    tz: win.tz,
    trafficClass,
    operation: query.operation,
    outcome: query.outcome,
    requestSource: query.request_source,
    platform: query.platform,
    responseMode: query.response_mode,
    groupBy: validatedGroups(query.group_by),
  });
  return {
    schema_version: "subkit.usage-stats.v1" as const,
    surface,
    bucket: win.bucket,
    tz: win.tz,
    from: win.from.toISOString(),
    to: win.to.toISOString(),
    ...(win.truncated_at ? { truncated_at: win.truncated_at } : {}),
    traffic_class: trafficClass,
    ...result,
    semantic: {
      value_state: !usageConfig.enabled
        ? ("missing" as const)
        : result.totals.calls === 0
          ? ("zero" as const)
          : ("measured" as const),
      value_kind: "count" as const,
      unit: "calls" as const,
    },
    quality: {
      sampled: false as const,
      unique_scope: "exact_window" as const,
      identity: "product_local_hmac" as const,
      content_captured: false as const,
      retention_days: usageConfig.retention_days,
      duration_coverage: {
        numerator: result.totals.duration_ms.measured,
        denominator: result.totals.calls,
      },
    },
  };
}

function usageOperation(
  surface: UsageSurface,
  summary: string,
): Operation<UsageQuery, UsageReport> {
  return defineOperation<UsageQuery, UsageReport>({
    id: `stats.usage.${surface}`,
    summary,
    permission: "stats:read",
    effect: "read",
    async handler(scope, query) {
      try {
        return await buildReport(scope.db, scope.tenant_id, surface, query);
      } catch (error) {
        if (error instanceof BadRequestError)
          return reject.badRequest(error.message, error.details);
        throw error;
      }
    },
    http: {
      method: "get",
      path: `/v1/stats/${surface}`,
      tags: ["Stats"],
      query: UsageStatsQuery,
      response: UsageStatsResponse,
      success: {
        status: 200,
        description: "Exact tenant-scoped usage report (no content or raw identifiers)",
      },
      errors: { 400: "Invalid window, traffic class, or grouping" },
      toInput: ({ query }) => query as UsageQuery,
      toBody: (report) => report,
    },
  });
}

export const httpUsageStatsOperation = usageOperation(
  "http",
  "HTTP route usage, latency, bytes, and errors",
);
export const chatUsageStatsOperation = usageOperation(
  "chat",
  "Chat turns, delivery modes, deduplication, and outcomes",
);
export const mcpUsageStatsOperation = usageOperation(
  "mcp",
  "MCP JSON-RPC, session, capacity, task, and SSE usage",
);
export const conversationsUsageStatsOperation = usageOperation(
  "conversations",
  "Conversation calls, streaming completion, disconnects, and outcomes",
);
