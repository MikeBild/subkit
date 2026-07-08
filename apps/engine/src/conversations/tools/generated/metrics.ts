import { z } from "@hono/zod-openapi";
import { can } from "../../../rbac/evaluator.ts";
import type { ConversationTool, ToolContext } from "../index.ts";

const EmptyInput = z
  .object({
    user_id: z
      .string()
      .uuid()
      .optional()
      .describe("Scope to one user. A user other than yourself requires stats:read:all."),
  })
  .openapi("MetricsInput");
const UsageInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    user_id: z
      .string()
      .uuid()
      .optional()
      .describe("Scope to one user. A user other than yourself requires stats:read:all."),
  })
  .openapi("LlmUsageInput");

/**
 * Resolve which user this metrics call may read.
 *
 * - No `user_id` → the caller's own id (self). When the principal is
 *   absent (resume paths) and there is no actor_id, returns `tenant: true`
 *   so the existing tenant-wide behaviour is preserved for system flows.
 * - `user_id === self` → allowed (self).
 * - `user_id !== self` → requires the `stats:read:all` permission via the
 *   tool ctx principal; denied otherwise.
 */
async function resolveUsageScope(
  ctx: ToolContext,
  requestedUserId: string | undefined,
): Promise<
  | { ok: true; userId: string | null; tenant: boolean }
  | { ok: false; error: { ok: false; data: { error: string; permission: string } } }
> {
  const selfId = ctx.principal?.id ?? ctx.actor_id ?? null;

  if (!requestedUserId) {
    // Self when we know who the caller is; otherwise tenant-wide (system flow).
    return selfId
      ? { ok: true, userId: selfId, tenant: false }
      : { ok: true, userId: null, tenant: true };
  }

  if (selfId && requestedUserId === selfId) {
    return { ok: true, userId: requestedUserId, tenant: false };
  }

  // Cross-user read — require stats:read:all on the ctx principal.
  if (!ctx.principal) {
    return {
      ok: false,
      error: {
        ok: false,
        data: { error: "permission_denied", permission: "stats:read:all" },
      },
    };
  }
  const decision = await can(ctx.db, {
    tenant_id: ctx.tenant_id,
    principal: ctx.principal,
    permission: "stats:read:all",
  });
  if (!decision.allow) {
    return {
      ok: false,
      error: {
        ok: false,
        data: { error: "permission_denied", permission: "stats:read:all" },
      },
    };
  }
  return { ok: true, userId: requestedUserId, tenant: false };
}

export const getLlmUsageTool: ConversationTool = {
  name: "get_llm_usage",
  description:
    "Return this month's total LLM token usage and the N most recent llm_usage rows. Defaults to your own usage; pass user_id to scope to another user (requires stats:read:all).",
  inputSchema: UsageInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof UsageInput>) {
    const scope = await resolveUsageScope(ctx, args.user_id);
    if (!scope.ok) return scope.error;
    const limit = args.limit ?? 20;

    const [monthly, recent] =
      scope.tenant || scope.userId == null
        ? await Promise.all([
            ctx.engineClient.metrics.monthlyTokenUsage(),
            ctx.engineClient.metrics.llmUsageRecent(limit),
          ])
        : await Promise.all([
            ctx.engineClient.metrics.monthlyTokenUsageForUser(scope.userId),
            ctx.engineClient.metrics.llmUsageRecentForUser(scope.userId, limit),
          ]);

    return {
      ok: true,
      data: {
        month_bucket: ctx.engineClient.metrics.currentMonthBucket(),
        user_id: scope.userId,
        monthly_total_tokens: monthly,
        recent: recent.map((r) => ({
          flow: r.flow,
          model: r.model,
          prompt_tokens: r.prompt_tokens,
          completion_tokens: r.completion_tokens,
          latency_ms: r.latency_ms,
          result: r.result,
          created_at: r.created_at,
        })),
      },
    };
  },
};

export const getTokenBudgetTool: ConversationTool = {
  name: "get_token_budget",
  description:
    "Report current-month token usage against the configured budget. Defaults to your own usage + per-user budget; pass user_id to scope to another user (requires stats:read:all).",
  inputSchema: EmptyInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof EmptyInput>) {
    const scope = await resolveUsageScope(ctx, args.user_id);
    if (!scope.ok) return scope.error;

    if (scope.tenant || scope.userId == null) {
      const used = await ctx.engineClient.metrics.monthlyTokenUsage();
      return {
        ok: true,
        data: {
          user_id: null,
          used_tokens: used,
          budget_tokens: null,
          month_bucket: ctx.engineClient.metrics.currentMonthBucket(),
        },
      };
    }

    const [used, budget] = await Promise.all([
      ctx.engineClient.metrics.monthlyTokenUsageForUser(scope.userId),
      ctx.engineClient.metrics.userTokenBudget(scope.userId),
    ]);
    return {
      ok: true,
      data: {
        user_id: scope.userId,
        used_tokens: used,
        budget_tokens: budget,
        remaining_tokens: budget == null ? null : Math.max(budget - used, 0),
        month_bucket: ctx.engineClient.metrics.currentMonthBucket(),
      },
    };
  },
};

export const metricsReadTools: ConversationTool[] = [getLlmUsageTool, getTokenBudgetTool];
