// GET /v1/stats/connectors — tenant-scoped, time-bucketed connector-call
// stats over `audit_log`. Gated by `stats:read`.
//
// ONE ROW PER CALL. An http / graphql / s3 / postgres call is the egress row
// `connector.invoked`. An mcp call is the pool's `mcp_external_tool.invoked`
// row: the pool writes one for every remote call, the chat palette's as well
// as a workflow step's, while only the workflow path ALSO passes the egress
// wrapper. Counting both actions for mcp would count a workflow's call twice;
// counting only the egress row left every chat call at zero. So the mcp
// egress row is left out and the pool row counts.

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { AuditAction } from "../../../audit/index.ts";
import {
  type AuditGroupDim,
  type AuditOutcome,
  aggregateAudit,
  type StatusClass,
} from "../../../stats/aggregate-audit.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { clampToRetentionHorizon, resolveWindow } from "./bucket-window.ts";
import { ConnectorsStatsQuery, ConnectorsStatsResponse } from "./schemas.ts";

const CONNECTOR_DIMS: AuditGroupDim[] = [
  "connector_id",
  "connector_slug",
  "driver",
  "outcome",
  "status_class",
  "method",
];
const OUTCOMES: AuditOutcome[] = ["success", "denied", "error"];
const STATUS_CLASSES: StatusClass[] = [
  "2xx",
  "3xx",
  "4xx_other",
  "4xx_auth",
  "4xx_rate_limited",
  "5xx",
  "network_error",
  "no_status",
];

const route = createRoute({
  method: "get",
  path: "/v1/stats/connectors",
  tags: ["Stats"],
  summary: "Time-bucketed connector-call stats (volume + latency + outcome distribution)",
  security: [{ bearerAuth: [] }],
  request: { query: ConnectorsStatsQuery },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ConnectorsStatsResponse } },
    },
    400: {
      description: "Invalid window",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerStatsConnectorsRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const win = await clampToRetentionHorizon(db, principal.tenant_id, resolveWindow(q));

    const groupBy = (q.group_by ?? []).filter((d): d is AuditGroupDim =>
      (CONNECTOR_DIMS as string[]).includes(d),
    );
    const outcome = (q.outcome ?? []).filter((o): o is AuditOutcome =>
      (OUTCOMES as string[]).includes(o),
    );
    const statusClass = (q.status_class ?? []).filter((s): s is StatusClass =>
      (STATUS_CLASSES as string[]).includes(s),
    );

    const result = await aggregateAudit(db, {
      tenantId: principal.tenant_id,
      bucket: win.bucket,
      from: win.from,
      to: win.to,
      tz: win.tz,
      actions: [AuditAction.CONNECTOR_INVOKED, AuditAction.MCP_EXTERNAL_TOOL_INVOKED],
      excludeActionDriver: { action: AuditAction.CONNECTOR_INVOKED, driver: "mcp" },
      connectorId: q.connector_id,
      connectorSlug: q.connector_slug,
      driver: q.driver,
      method: q.method,
      outcome: outcome.length > 0 ? outcome : undefined,
      statusClass: statusClass.length > 0 ? statusClass : undefined,
      groupBy,
      includeEndpoint: q.include_endpoint,
    });

    return c.json(
      {
        bucket: win.bucket,
        tz: win.tz,
        from: win.from.toISOString(),
        to: win.to.toISOString(),
        ...(win.truncated_at ? { truncated_at: win.truncated_at } : {}),
        ...result,
      },
      200,
    );
  });
}
