// GET /v1/stats/quality — tenant-scoped, time-windowed workflow-quality
// stats. Gated by `stats:read`.
//
// Three rollups in one response: one-shot success rate, failure reasons by
// step error code, and post-repair success rate. All numbers are aggregated
// at read time from `executions` / `execution_steps` / `patch_candidates` —
// no new persistence.

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";

import { ErrorSchema } from "../../../api/common-schemas.ts";
import { aggregateQuality } from "../../../stats/aggregate-quality.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { resolveWindow } from "./bucket-window.ts";
import { StatsQualityQuery, StatsQualityResponse } from "./schemas.ts";

const route = createRoute({
  method: "get",
  path: "/v1/stats/quality",
  tags: ["Stats"],
  summary: "Workflow quality: one-shot success, failure reasons, post-repair success",
  security: [{ bearerAuth: [] }],
  request: { query: StatsQualityQuery },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: StatsQualityResponse } },
    },
    400: {
      description: "Invalid window",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerStatsQualityRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const win = resolveWindow(q);

    const result = await aggregateQuality(db, {
      tenantId: principal.tenant_id,
      from: win.from,
      to: win.to,
      workflowId: q.workflow_id,
    });

    return c.json(
      {
        bucket: win.bucket,
        tz: win.tz,
        from: win.from.toISOString(),
        to: win.to.toISOString(),
        ...result,
      },
      200,
    );
  });
}
