// GET /v1/stats/executions — tenant-scoped, time-bucketed execution
// stats. Gated by `stats:read`.

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import {
  aggregateExecutions,
  type ExecutionGroupDim,
} from "../../../stats/aggregate-executions.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { resolveWindow } from "./bucket-window.ts";
import { ExecutionsStatsQuery, ExecutionsStatsResponse } from "./schemas.ts";

const EXEC_DIMS: ExecutionGroupDim[] = ["workflow_id", "status", "request_source"];

const route = createRoute({
  method: "get",
  path: "/v1/stats/executions",
  tags: ["Stats"],
  summary: "Time-bucketed workflow execution stats (count + duration distribution)",
  security: [{ bearerAuth: [] }],
  request: { query: ExecutionsStatsQuery },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ExecutionsStatsResponse } },
    },
    400: {
      description: "Invalid window",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerStatsExecutionsRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const win = resolveWindow(q);

    const groupBy = (q.group_by ?? []).filter((d): d is ExecutionGroupDim =>
      (EXEC_DIMS as string[]).includes(d),
    );

    const result = await aggregateExecutions(db, {
      tenantId: principal.tenant_id,
      bucket: win.bucket,
      from: win.from,
      to: win.to,
      tz: win.tz,
      workflowId: q.workflow_id,
      status: q.status,
      requestSource: q.request_source,
      executionMode: q.execution_mode,
      groupBy,
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
