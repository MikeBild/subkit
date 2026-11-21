import { z } from "@hono/zod-openapi";
import { can } from "../../../rbac/evaluator.ts";
import type { ConversationTool, ToolContext } from "../index.ts";

const UsageInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    from: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("Start of the priced window (ISO 8601). Default: the start of this UTC month."),
    to: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("End of the priced window (ISO 8601, exclusive). Default: now."),
    user_id: z
      .string()
      .uuid()
      .optional()
      .describe("Scope to one user. A user other than yourself requires stats:read:all."),
  })
  .openapi("LlmUsageInput");

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function resolveUsageScope(
  ctx: ToolContext,
  requestedUserId: string | undefined,
): Promise<
  | { ok: true; userId: string | null; tenant: boolean }
  | { ok: false; error: { ok: false; data: { error: string; permission: string } } }
> {
  const selfId = ctx.principal?.id ?? ctx.actor_id ?? null;

  if (!requestedUserId) {
    return selfId
      ? { ok: true, userId: selfId, tenant: false }
      : { ok: true, userId: null, tenant: true };
  }

  if (selfId && requestedUserId === selfId) {
    return { ok: true, userId: requestedUserId, tenant: false };
  }

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

const getLlmUsageTool: ConversationTool = {
  name: "get_llm_usage",
  description:
    "Return this month's total LLM token usage, the priced spend over a window (default: this month) and the N most recent llm_usage rows. `cost` prices every model at SubKit's built-in list price unless the operator overrides it (`price_sources` names catalog or override per model); a model neither prices is named in `unpriced_models`, never counted as free. Defaults to your own usage; pass user_id to scope to another user (requires stats:read:all).",
  inputSchema: UsageInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof UsageInput>) {
    const scope = await resolveUsageScope(ctx, args.user_id);
    if (!scope.ok) return scope.error;
    const limit = args.limit ?? 20;
    const now = new Date();
    const window = {
      from: args.from ? new Date(args.from) : monthStart(now),
      to: args.to ? new Date(args.to) : now,
    };
    if (window.to.getTime() <= window.from.getTime()) {
      return { ok: false, data: { error: "invalid_window", message: "to must be after from" } };
    }
    const mayReadCost = ctx.principal
      ? (
          await can(ctx.db, {
            tenant_id: ctx.tenant_id,
            principal: ctx.principal,
            permission: "stats:read",
            quiet: true,
          })
        ).allow
      : true;

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

    const cost = mayReadCost
      ? await ctx.engineClient.metrics.llmWindowCost({ ...window, userId: scope.userId })
      : null;

    return {
      ok: true,
      data: {
        month_bucket: ctx.engineClient.metrics.currentMonthBucket(),
        user_id: scope.userId,
        monthly_total_tokens: monthly,
        window: { from: window.from.toISOString(), to: window.to.toISOString() },
        cost,
        ...(cost === null ? { cost_withheld: { permission: "stats:read" } } : {}),
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

const getAiBudgetTool: ConversationTool = {
  name: "get_ai_budget",
  description:
    "Report this month's AI spending against the workspace's monthly AI budget, the only spending limit. `state` is unlimited, ok, warning (from 80 %), reached (chat, tasks and model steps pause) or continued (an admin chose to go on without a limit this month). Only priced calls count; amounts are in `currency`, and the budget only applies when that is USD.",
  inputSchema: z.object({}).strict(),
  category: "tenant_read",
  async execute(ctx) {
    const budget = await ctx.engineClient.metrics.aiBudget();
    return {
      ok: true,
      data: {
        month: budget.month,
        timezone: budget.timezone,
        currency: budget.currency,
        limit: budget.limit_usd,
        spent: budget.spent_usd,
        unpriced_calls: budget.unpriced_calls,
        state: budget.state,
      },
    };
  },
};

export const metricsReadTools: ConversationTool[] = [getLlmUsageTool, getAiBudgetTool];
