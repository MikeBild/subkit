// GET /v1/stats/llm — tenant-scoped, time-bucketed LLM token usage +
// cache-hit + latency stats over `llm_usage`. Gated by `stats:read`.

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { can } from "../../../rbac/index.ts";
import { aggregateLlm, type LlmGroupDim } from "../../../stats/aggregate-llm.ts";
import { ForbiddenError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { resolveWindow } from "./bucket-window.ts";
import { LlmStatsQuery, LlmStatsResponse } from "./schemas.ts";

const LLM_DIMS: LlmGroupDim[] = ["model", "flow", "user"];

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
    403: {
      description: "Cross-user usage requires stats:read:all",
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

    // The blanket app.use already enforced `stats:read`. Reading ANOTHER
    // user's rows, or a cross-user breakdown (`group-by=user`), is a
    // privileged operation that additionally requires `stats:read:all`.
    // Reading only your own usage (`user_id` absent or == your id) passes
    // on `stats:read` alone.
    const targetsOtherUser = q.user_id != null && q.user_id !== principal.id;
    const crossUserBreakdown = groupBy.includes("user");
    if (targetsOtherUser || crossUserBreakdown) {
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "stats:read:all",
      });
      if (!decision.allow) {
        throw new ForbiddenError(
          "permission_denied:stats:read:all — reading another user's usage or a cross-user breakdown requires the stats:read:all permission",
        );
      }
    }

    const result = await aggregateLlm(db, {
      tenantId: principal.tenant_id,
      bucket: win.bucket,
      from: win.from,
      to: win.to,
      tz: win.tz,
      model: q.model,
      flow: q.flow,
      userId: q.user_id,
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
