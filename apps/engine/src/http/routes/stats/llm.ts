// GET /v1/stats/llm — tenant-scoped, time-bucketed LLM token usage +
// cache-hit + latency stats over `llm_usage`. Gated by `stats:read`.

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { modelDisplayName } from "../../../llm/index.ts";
import { can } from "../../../rbac/index.ts";
import { aggregateLlm, type LlmGroupDim } from "../../../stats/aggregate-llm.ts";
import { readLlmCostByGroup, readLlmWindowCost } from "../../../stats/llm-cost.ts";
import { BadRequestError, ForbiddenError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { resolveWindow } from "./bucket-window.ts";
import { LlmStatsQuery, LlmStatsResponse } from "./schemas.ts";

// `workflow` reaches through `executions` to the workflow that ran the call.
// It exists because model and flow together still cannot answer "which
// workflow is spending the money" — the question the August 2026 cost
// investigation actually turned on, and the one that previously forced a
// direct SQL query over ssh because no endpoint could serve it.
const LLM_DIMS: LlmGroupDim[] = ["model", "flow", "user", "workflow"];

/**
 * Reject what cannot be served instead of serving something else.
 *
 * The aggregator groups by at most two dimensions (`groupBy.slice(0, 2)`), and
 * this route used to silently drop both the third dimension and any name it
 * did not recognise. A caller asking for three got two back with nothing in
 * the response saying so — and with a fourth dimension now on offer, asking
 * for three is the natural thing to try.
 *
 * `GET /v1/stats/usage` already draws exactly this line; the wording and the
 * `reason` codes match it deliberately, so the two endpoints fail the same way.
 */
function validatedGroups(values: string[] | undefined): LlmGroupDim[] {
  const requested = values ?? [];
  if (requested.length > 2) {
    throw new BadRequestError("group_by accepts at most two dimensions", {
      reason: "group_by_too_many",
    });
  }
  if (requested.some((value) => !(LLM_DIMS as string[]).includes(value))) {
    throw new BadRequestError(`group_by must contain only: ${LLM_DIMS.join(", ")}`, {
      reason: "group_by_invalid",
    });
  }
  return requested as LlmGroupDim[];
}

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
      description: "Invalid window, or an unusable group_by",
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

    const groupBy = validatedGroups(q.group_by);

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

    // Money for the window, priced per model — through the reader
    // `get_llm_usage` prices with, so both answer with the same amount,
    // price sources and unpriced models for the same window.
    const window = {
      tenantId: principal.tenant_id,
      bucket: win.bucket,
      from: win.from,
      to: win.to,
      tz: win.tz,
      model: q.model,
      flow: q.flow,
      userId: q.user_id,
    };
    const cost = await readLlmWindowCost(db, window);
    // With one dimension each group gets its own amount — "what did this
    // workflow cost" is the question a breakdown by workflow is asked.
    const [only] = groupBy;
    const groupCost =
      groupBy.length === 1 && only ? await readLlmCostByGroup(db, window, only) : null;
    const priced = groupCost
      ? result.groups.map((group) => {
          const priced = groupCost.get(group.key[only as string] ?? "");
          return priced
            ? {
                ...group,
                cost: {
                  amount: priced.amount,
                  currency: priced.currency,
                  unpriced_calls: priced.unpriced_calls,
                },
              }
            : group;
        })
      : result.groups;
    const groups = priced.map((group) => {
      const name = group.key.model ? modelDisplayName(group.key.model) : null;
      return name ? { ...group, model_name: name } : group;
    });

    return c.json(
      {
        bucket: win.bucket,
        tz: win.tz,
        from: win.from.toISOString(),
        to: win.to.toISOString(),
        ...result,
        groups,
        cost,
      },
      200,
    );
  });
}
