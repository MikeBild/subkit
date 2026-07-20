// GET /v1/stats/{http,chat,mcp,conversations} — semantic, privacy-safe
// product usage reports over the shared tenant-scoped usage ledger.

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { getConfig } from "../../../config/loader.ts";
import type { Db } from "../../../db/client.ts";
import {
  aggregateUsage,
  USAGE_GROUP_DIMS,
  type UsageGroupDim,
} from "../../../stats/aggregate-usage.ts";
import {
  TRAFFIC_CLASSES,
  type TrafficClass,
  type UsageSurface,
} from "../../../stats/usage-events.ts";
import { now } from "../../../utils/clock.ts";
import { BadRequestError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { type ResolvedWindow, resolveWindow } from "./bucket-window.ts";
import { UsageStatsQuery, UsageStatsResponse } from "./schemas.ts";

function usageRoute(path: string, summary: string) {
  return createRoute({
    method: "get",
    path,
    tags: ["Stats"],
    summary,
    security: [{ bearerAuth: [] }],
    request: { query: UsageStatsQuery },
    responses: {
      200: {
        description: "Exact tenant-scoped usage report (no content or raw identifiers)",
        content: { "application/json": { schema: UsageStatsResponse } },
      },
      400: {
        description: "Invalid window, traffic class, or grouping",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });
}

const httpRoute = usageRoute("/v1/stats/http", "HTTP route usage, latency, bytes, and errors");
const chatRoute = usageRoute(
  "/v1/stats/chat",
  "Chat turns, delivery modes, deduplication, and outcomes",
);
const mcpRoute = usageRoute(
  "/v1/stats/mcp",
  "MCP JSON-RPC, session, capacity, task, and SSE usage",
);
const conversationsRoute = usageRoute(
  "/v1/stats/conversations",
  "Conversation calls, streaming completion, disconnects, and outcomes",
);

type UsageQuery = ReturnType<typeof UsageStatsQuery.parse>;

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

async function buildReport(args: {
  db: Db;
  tenantId: string;
  surface: UsageSurface;
  query: UsageQuery;
}) {
  const usageConfig = getConfig().observability.usage;
  const win = retentionWindow(resolveWindow(args.query), usageConfig.retention_days);
  const trafficClass = validatedTraffic(args.query.traffic_class);
  const result = await aggregateUsage(args.db, {
    tenantId: args.tenantId,
    surface: args.surface,
    bucket: win.bucket,
    from: win.from,
    to: win.to,
    tz: win.tz,
    trafficClass,
    operation: args.query.operation,
    outcome: args.query.outcome,
    requestSource: args.query.request_source,
    platform: args.query.platform,
    responseMode: args.query.response_mode,
    groupBy: validatedGroups(args.query.group_by),
  });
  return {
    schema_version: "subkit.usage-stats.v1" as const,
    surface: args.surface,
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

export function registerUsageStatsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(httpRoute, async (c) => {
    const principal = requireAuth(c);
    return c.json(
      await buildReport({
        db: c.get("db"),
        tenantId: principal.tenant_id,
        surface: "http",
        query: c.req.valid("query"),
      }),
      200,
    );
  });
  app.openapi(chatRoute, async (c) => {
    const principal = requireAuth(c);
    return c.json(
      await buildReport({
        db: c.get("db"),
        tenantId: principal.tenant_id,
        surface: "chat",
        query: c.req.valid("query"),
      }),
      200,
    );
  });
  app.openapi(mcpRoute, async (c) => {
    const principal = requireAuth(c);
    return c.json(
      await buildReport({
        db: c.get("db"),
        tenantId: principal.tenant_id,
        surface: "mcp",
        query: c.req.valid("query"),
      }),
      200,
    );
  });
  app.openapi(conversationsRoute, async (c) => {
    const principal = requireAuth(c);
    return c.json(
      await buildReport({
        db: c.get("db"),
        tenantId: principal.tenant_id,
        surface: "conversations",
        query: c.req.valid("query"),
      }),
      200,
    );
  });
}
