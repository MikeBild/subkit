// GET /v1/stats/llm — tenant-scoped, time-bucketed LLM token usage +
// cache-hit + latency stats over `llm_usage`. Gated by `stats:read`.

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { aggregateLlm, type LlmGroupDim } from "../../../stats/aggregate-llm.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { resolveWindow } from "./bucket-window.ts";
import { LlmStatsQuery, LlmStatsResponse } from "./schemas.ts";

const LLM_DIMS: LlmGroupDim[] = ["model", "flow"];

const route = createRoute({
  method: "get",
  path: "/v1/stats/llm",
  tags: ["Stats"],
  summary: "Time-bucketed LLM token usage + cache-hit + latency stats",
  security: [{ bearerAuth: [] }],
  request: { query: LlmStatsQuery },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: LlmStatsResponse } } },
    400: {
      description: "Invalid window",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerStatsLlmRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const win = resolveWindow(q);

    const groupBy = (q.group_by ?? []).filter((d): d is LlmGroupDim =>
      (LLM_DIMS as string[]).includes(d),
    );

    const result = await aggregateLlm(db, {
      tenantId: principal.tenant_id,
      bucket: win.bucket,
      from: win.from,
      to: win.to,
      tz: win.tz,
      model: q.model,
      flow: q.flow,
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
