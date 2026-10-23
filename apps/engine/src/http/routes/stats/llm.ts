import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import type { CostResult } from "../../../llm/index.ts";
import { modelDisplayName } from "../../../llm/index.ts";
import { can } from "../../../rbac/index.ts";
import {
  aggregateLlm,
  LLM_GROUP_DIMS,
  LLM_RESULTS,
  type LlmGroupDim,
  llmBucketKey,
  llmGroupKey,
} from "../../../stats/aggregate-llm.ts";
import {
  effectiveModelRate,
  readLlmCostByKey,
  readLlmWindowCost,
} from "../../../stats/llm-cost.ts";
import { readConversationLabels } from "../../../stats/llm-labels.ts";
import { BadRequestError, ForbiddenError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { resolveWindow } from "./bucket-window.ts";
import { LlmStatsQuery, LlmStatsResponse } from "./schemas.ts";

const LLM_DIMS: readonly string[] = LLM_GROUP_DIMS;
const CROSS_USER_DIMS: readonly LlmGroupDim[] = ["user", "conversation"];

function validatedResults(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  if (values.some((value) => !(LLM_RESULTS as readonly string[]).includes(value))) {
    throw new BadRequestError(`result must contain only: ${LLM_RESULTS.join(", ")}`, {
      reason: "result_invalid",
    });
  }
  return values;
}

function partCost(cost: CostResult) {
  return {
    amount: cost.amount,
    currency: cost.currency,
    unpriced_calls: cost.unpriced_calls,
    cache_savings: cost.cache_savings,
  };
}

function validatedGroups(values: string[] | undefined): LlmGroupDim[] {
  const requested = values ?? [];
  if (requested.length > 2) {
    throw new BadRequestError("group_by accepts at most two dimensions", {
      reason: "group_by_too_many",
    });
  }
  if (requested.some((value) => !LLM_DIMS.includes(value))) {
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
  summary: "Time-bucketed LLM token usage, cost, cache savings and latency stats",
  security: [{ bearerAuth: [] }],
  request: { query: LlmStatsQuery },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: LlmStatsResponse } } },
    400: {
      description: "Invalid window, or an unusable group_by",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description:
        "Another user's usage, or a breakdown by user or conversation, requires stats:read:all",
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
    const result = validatedResults(q.result);

    const targetsOtherUser = q.user_id != null && q.user_id !== principal.id;
    const crossUserBreakdown =
      groupBy.some((dim) => CROSS_USER_DIMS.includes(dim)) && q.user_id !== principal.id;
    if (targetsOtherUser || crossUserBreakdown) {
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "stats:read:all",
      });
      if (!decision.allow) {
        throw new ForbiddenError(
          "permission_denied:stats:read:all — reading another user's usage or a breakdown by user or conversation requires the stats:read:all permission",
        );
      }
    }

    const window = {
      tenantId: principal.tenant_id,
      bucket: win.bucket,
      from: win.from,
      to: win.to,
      tz: win.tz,
      model: q.model,
      flow: q.flow,
      userId: q.user_id,
      result,
      workflowId: q.workflow_id,
    };
    const aggregated = await aggregateLlm(db, { ...window, groupBy });
    const cost = await readLlmWindowCost(db, window);
    const keyed = await readLlmCostByKey(db, window, groupBy);

    const conversationIds = groupBy.includes("conversation")
      ? aggregated.groups.map((group) => group.key.conversation ?? "").filter(Boolean)
      : [];
    const titlesReadable =
      conversationIds.length > 0 &&
      (
        await can(db, {
          tenant_id: principal.tenant_id,
          principal,
          permission: "conversation:read",
        })
      ).allow;
    const labels = titlesReadable
      ? await readConversationLabels(db, principal.tenant_id, conversationIds)
      : new Map();

    const groups = aggregated.groups.map((group) => {
      const groupKey = llmGroupKey(groupBy, group.key);
      const groupCost = keyed.groups.get(groupKey);
      const model = group.key.model;
      const name = model ? modelDisplayName(model) : null;
      const rate = model ? effectiveModelRate(principal.tenant_id, model) : null;
      const label = group.key.conversation ? labels.get(group.key.conversation) : undefined;
      return {
        ...group,
        buckets: group.buckets.map((bucket) => {
          const bucketCost = keyed.buckets.get(llmBucketKey(groupKey, bucket.ts));
          return bucketCost ? { ...bucket, cost: partCost(bucketCost) } : bucket;
        }),
        ...(groupCost ? { cost: partCost(groupCost) } : {}),
        ...(name ? { model_name: name } : {}),
        ...(rate ? { model_price: rate } : {}),
        ...(label ? { conversation: label } : {}),
      };
    });

    return c.json(
      {
        bucket: win.bucket,
        tz: win.tz,
        from: win.from.toISOString(),
        to: win.to.toISOString(),
        ...aggregated,
        groups,
        cost,
      },
      200,
    );
  });
}
