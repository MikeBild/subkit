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

/** The first instant of `now`'s UTC month — the month `month_bucket` names. */
function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

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
/**
 * Which of a caller's two ceilings refuses the next call first.
 *
 * `checkAndDecrement` treats the per-user cap as an ADDITIONAL ceiling on top
 * of the workspace's, so a caller is bounded by whichever has less room left.
 * A reader told only about the per-user one reads "nothing bounds you" on
 * every installation that never set a personal cap — while the workspace cap
 * is what actually stops them.
 *
 * `null` remaining means that ceiling is absent, not that it is exhausted.
 * Both absent means nothing binds; the caller is unbounded.
 */
export function bindingCeiling(
  userRemaining: number | null,
  tenantRemaining: number | null,
): "user" | "tenant" | null {
  if (userRemaining == null && tenantRemaining == null) return null;
  if (userRemaining == null) return "tenant";
  if (tenantRemaining == null) return "user";
  // Ties go to the user cap: it is the narrower statement about this caller,
  // and it is the one the dispatch evaluates first.
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
    // Money is a `stats:read` figure, as `GET /v1/stats/llm` gates it: a caller
    // without it still reads its own tokens, and is told the cost is withheld
    // rather than handed an empty one.
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

export const getTokenBudgetTool: ConversationTool = {
  name: "get_token_budget",
  description:
    "Report current-month token usage against the ceiling that will actually refuse the next call. A caller is bounded by both a per-user cap and the workspace cap; `budget_tokens`/`remaining_tokens`/`state` (ample, tightening at 75 %, critical at 90 %) describe whichever binds first, `binding_scope` names it, and `user`/`tenant` carry both so the answer can be checked. Defaults to your own figures; pass user_id to scope to another user (requires stats:read:all).",
  inputSchema: EmptyInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof EmptyInput>) {
    const scope = await resolveUsageScope(ctx, args.user_id);
    if (!scope.ok) return scope.error;

    if (scope.tenant || scope.userId == null) {
      // Both halves, same shape as the per-user branch below. This used to
      // hardcode `budget_tokens: null` and omit `remaining_tokens` entirely —
      // so a tool called "get token budget" could not report the workspace's
      // budget, and its two branches answered with two different objects. The
      // value was resolvable the whole time; `/v1/status` had been returning
      // it from the same source.
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

    // A caller is bounded by TWO ceilings and the dispatch refuses at
    // whichever it reaches first (`checkAndDecrement`: the per-user cap is an
    // ADDITIONAL ceiling on top of the workspace's, not a replacement).
    //
    // This branch used to report only the per-user cap. A caller with no
    // personal cap — which is every caller on an installation that never set
    // one — therefore read `budget_tokens: null`, "nothing bounds you", while
    // the workspace cap was what would actually stop the next call. Found on
    // a live installation minutes after that cap was made settable: the tool
    // still said `null` with a hundred and fifty million configured.
    //
    // So the headline is the binding ceiling, and both are carried beside it
    // so the answer can be reconciled rather than believed.
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
