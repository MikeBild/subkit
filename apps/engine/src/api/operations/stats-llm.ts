import type { z } from "@hono/zod-openapi";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { BadRequestError, ForbiddenError } from "../../http/errors.ts";
import { modelDisplayName } from "../../llm/model-names.ts";
import type { CostResult } from "../../llm/pricing.ts";
import { can } from "../../rbac/evaluator.ts";
import {
  aggregateLlm,
  LLM_GROUP_DIMS,
  LLM_RESULTS,
  type LlmGroupDim,
  llmBucketKey,
  llmGroupKey,
} from "../../stats/aggregate-llm.ts";
import { effectiveModelRate, readLlmCostByKey, readLlmWindowCost } from "../../stats/llm-cost.ts";
import { readConversationLabels } from "../../stats/llm-labels.ts";
import { resolveWindow } from "../stats/bucket-window.ts";
import { LlmStatsQuery, LlmStatsResponse } from "../stats/schemas.ts";
import { defineOperation, reject } from "./index.ts";
import { settleStats } from "./stats.ts";

type LlmQuery = z.infer<typeof LlmStatsQuery>;
type LlmReport = Awaited<ReturnType<typeof llmReport>>;

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

async function ensureCrossUserRead(
  db: Db,
  principal: ResolvedPrincipal,
  query: LlmQuery,
  groupBy: readonly LlmGroupDim[],
): Promise<void> {
  const targetsOtherUser = query.user_id != null && query.user_id !== principal.id;
  const crossUserBreakdown =
    groupBy.some((dim) => CROSS_USER_DIMS.includes(dim)) && query.user_id !== principal.id;
  if (!targetsOtherUser && !crossUserBreakdown) return;
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

async function conversationLabelsFor(
  db: Db,
  principal: ResolvedPrincipal,
  conversationIds: string[],
) {
  const titlesReadable =
    conversationIds.length > 0 &&
    (
      await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "conversation:read",
      })
    ).allow;
  return titlesReadable
    ? await readConversationLabels(db, principal.tenant_id, conversationIds)
    : new Map();
}

async function llmReport(db: Db, principal: ResolvedPrincipal, query: LlmQuery) {
  const win = resolveWindow(query);
  const groupBy = validatedGroups(query.group_by);
  const result = validatedResults(query.result);
  await ensureCrossUserRead(db, principal, query, groupBy);

  const window = {
    tenantId: principal.tenant_id,
    bucket: win.bucket,
    from: win.from,
    to: win.to,
    tz: win.tz,
    model: query.model,
    flow: query.flow,
    userId: query.user_id,
    result,
    workflowId: query.workflow_id,
  };
  const aggregated = await aggregateLlm(db, { ...window, groupBy });
  const cost = await readLlmWindowCost(db, window);
  const keyed = await readLlmCostByKey(db, window, groupBy);

  const conversationIds = groupBy.includes("conversation")
    ? aggregated.groups.map((group) => group.key.conversation ?? "").filter(Boolean)
    : [];
  const labels = await conversationLabelsFor(db, principal, conversationIds);

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

  return {
    bucket: win.bucket,
    tz: win.tz,
    from: win.from.toISOString(),
    to: win.to.toISOString(),
    ...aggregated,
    groups,
    cost,
  };
}

export const llmStatsOperation = defineOperation<LlmQuery, LlmReport>({
  id: "stats.llm",
  summary: "Time-bucketed LLM token usage, cost, cache savings and latency stats",
  permission: "stats:read",
  effect: "read",
  async handler(scope, query) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    return settleStats(() => llmReport(scope.db, principal, query));
  },
  http: {
    method: "get",
    path: "/v1/stats/llm",
    tags: ["Stats"],
    query: LlmStatsQuery,
    response: LlmStatsResponse,
    errors: {
      400: "Invalid window, or an unusable group_by",
      403: "Another user's usage, or a breakdown by user or conversation, requires stats:read:all",
    },
    toInput: ({ query }) => query as LlmQuery,
    toBody: (report) => report,
  },
});
