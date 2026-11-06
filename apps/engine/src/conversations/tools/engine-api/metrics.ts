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

export function bindingCeiling(
  userRemaining: number | null,
  tenantRemaining: number | null,
): "user" | "tenant" | null {
  if (userRemaining == null && tenantRemaining == null) return null;
  if (userRemaining == null) return "tenant";
  if (tenantRemaining == null) return "user";
  return userRemaining <= tenantRemaining ? "user" : "tenant";
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

const getTokenBudgetTool: ConversationTool = {
  name: "get_token_budget",
  description:
    "Report current-month token usage against the ceiling that will actually refuse the next call. A caller is bounded by both a per-user cap and the workspace cap; `budget_tokens`/`remaining_tokens`/`state` (ample, tightening at 75 %, critical at 90 %) describe whichever binds first, `binding_scope` names it, and `user`/`tenant` carry both so the answer can be checked. Defaults to your own figures; pass user_id to scope to another user (requires stats:read:all).",
  inputSchema: EmptyInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof EmptyInput>) {
    const scope = await resolveUsageScope(ctx, args.user_id);
    if (!scope.ok) return scope.error;

    if (scope.tenant || scope.userId == null) {
      const month = await ctx.engineClient.metrics.tenantMonthlyBudget();
      return {
        ok: true,
        data: {
          user_id: null,
          used_tokens: month.used_tokens,
          budget_tokens: month.budget_tokens,
          remaining_tokens: month.remaining_tokens,
          state: month.state,
          month_bucket: month.month_bucket,
        },
      };
    }

    const [userUsed, userBudget, tenantUsed] = await Promise.all([
      ctx.engineClient.metrics.monthlyTokenUsageForUser(scope.userId),
      ctx.engineClient.metrics.userTokenBudget(scope.userId),
      ctx.engineClient.metrics.monthlyTokenUsage(),
    ]);
    const tenantBudget = ctx.engineClient.metrics.tenantTokenBudget();
    const user = ctx.engineClient.metrics.monthlyBudgetFigures(userUsed, userBudget);
    const tenant = ctx.engineClient.metrics.monthlyBudgetFigures(tenantUsed, tenantBudget);
    const userRemaining = user.remaining_tokens;
    const tenantRemaining = tenant.remaining_tokens;
    const binding = bindingCeiling(userRemaining, tenantRemaining);

    return {
      ok: true,
      data: {
        user_id: scope.userId,
        month_bucket: ctx.engineClient.metrics.currentMonthBucket(),
        used_tokens: binding === "tenant" ? tenantUsed : userUsed,
        budget_tokens: binding === "tenant" ? tenantBudget : binding === "user" ? userBudget : null,
        remaining_tokens: binding === "tenant" ? tenantRemaining : userRemaining,
        state: binding === "tenant" ? tenant.state : binding === "user" ? user.state : null,
        binding_scope: binding,
        user: {
          used_tokens: userUsed,
          budget_tokens: userBudget,
          remaining_tokens: userRemaining,
          state: user.state,
        },
        tenant: {
          used_tokens: tenantUsed,
          budget_tokens: tenantBudget,
          remaining_tokens: tenantRemaining,
          state: tenant.state,
        },
      },
    };
  },
};

export const metricsReadTools: ConversationTool[] = [getLlmUsageTool, getTokenBudgetTool];
