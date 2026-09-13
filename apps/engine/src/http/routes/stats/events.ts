// GET /v1/stats/events — tenant-scoped, time-bucketed catch-all over the
// rest of `audit_log`, parameterized by `?class=`. Same audit aggregator
// as /connectors. Gated by `stats:read`.

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";

import { ErrorSchema } from "../../../api/common-schemas.ts";
import {
  aggregateAudit,
  type AuditGroupDim,
  type AuditOutcome,
} from "../../../stats/aggregate-audit.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { clampToRetentionHorizon, resolveWindow } from "./bucket-window.ts";
import { EVENT_CLASS_ACTIONS, type EventClass } from "./event-classes.ts";
import { EventsStatsQuery, EventsStatsResponse } from "./schemas.ts";

// `action` is the natural group axis for the events surface; `outcome`
// is also useful. The connector-specific dims (driver/status_class/…)
// are meaningless here.
const EVENT_DIMS: AuditGroupDim[] = ["action", "outcome"];
const OUTCOMES: AuditOutcome[] = ["success", "denied", "error"];

const route = createRoute({
  method: "get",
  path: "/v1/stats/events",
  tags: ["Stats"],
  summary: "Time-bucketed audit-event stats by class (webhooks, chat, self-healing, policy, …)",
  security: [{ bearerAuth: [] }],
  request: { query: EventsStatsQuery },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: EventsStatsResponse } } },
    400: {
      description: "Invalid window",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerStatsEventsRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const win = await clampToRetentionHorizon(db, principal.tenant_id, resolveWindow(q));

    const actions = EVENT_CLASS_ACTIONS[q.class as EventClass];

    // Default group axis is `action` so each class breaks down into its
    // member actions; callers can override with `group_by`.
    const requestedDims = (q.group_by ?? []).filter((d): d is AuditGroupDim =>
      (EVENT_DIMS as string[]).includes(d),
    );
    const groupBy = requestedDims.length > 0 ? requestedDims : (["action"] as AuditGroupDim[]);
    const outcome = (q.outcome ?? []).filter((o): o is AuditOutcome =>
      (OUTCOMES as string[]).includes(o),
    );

    const result = await aggregateAudit(db, {
      tenantId: principal.tenant_id,
      bucket: win.bucket,
      from: win.from,
      to: win.to,
      tz: win.tz,
      actions,
      outcome: outcome.length > 0 ? outcome : undefined,
      groupBy,
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
