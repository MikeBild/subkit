// Per-tenant monthly token budget accounting.
//
// Reads sum over `llm_usage.month_bucket = YYYYMM`. The ledger is
// append-only; every call writes one row regardless of outcome so
// operators can audit every LLM interaction against the budget.

import { and, eq, sql } from "drizzle-orm";
import { getConfig, isConfigLoaded } from "../../config/loader.ts";
import { type Executor, getDb } from "../../db/client.ts";
import { llmUsage, userLlmSettings } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { LlmQuotaExhausted } from "../errors.ts";
import { weightedTotalTokens } from "../pricing.ts";
import type { LlmCallLogEntry } from "../types.ts";

export function currentMonthBucket(d: Date = new Date()): number {
  return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);
}

/**
 * Sum of `total_tokens` consumed by a tenant in the current month.
 */
export async function monthlyUsage(tenant_id: string, exec?: Executor): Promise<number> {
  const db = exec ?? getDb();
  const bucket = currentMonthBucket();
  const out = await db
    .select({ total: sql<number>`coalesce(sum(${llmUsage.total_tokens}), 0)::int` })
    .from(llmUsage)
    .where(and(eq(llmUsage.tenant_id, tenant_id), eq(llmUsage.month_bucket, bucket)));
  return Number(out[0]?.total ?? 0);
}

/**
 * Sum of `total_tokens` consumed by one user within a tenant in the
 * current month. TENANT ISOLATION: tenant_id is the FIRST predicate;
 * user_id only narrows within it.
 */
export async function monthlyUsageForUser(
  tenant_id: string,
  user_id: string,
  exec?: Executor,
): Promise<number> {
  const db = exec ?? getDb();
  const bucket = currentMonthBucket();
  const out = await db
    .select({ total: sql<number>`coalesce(sum(${llmUsage.total_tokens}), 0)::int` })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.tenant_id, tenant_id),
        eq(llmUsage.user_id, user_id),
        eq(llmUsage.month_bucket, bucket),
      ),
    );
  return Number(out[0]?.total ?? 0);
}

/**
 * Resolve the effective monthly budget for a single user from
 * `user_llm_settings.llm_monthly_token_budget`. A null return means the
 * user has no explicit per-user cap (only the tenant budget applies).
 * TENANT ISOLATION: tenant_id is the FIRST predicate.
 */
export async function resolveUserMonthlyBudget(
  tenant_id: string,
  user_id: string,
  exec?: Executor,
): Promise<number | null> {
  const db = exec ?? getDb();
  const rows = await db
    .select({ budget: userLlmSettings.llm_monthly_token_budget })
    .from(userLlmSettings)
    .where(and(eq(userLlmSettings.tenant_id, tenant_id), eq(userLlmSettings.user_id, user_id)))
    .limit(1);
  const raw = rows[0]?.budget ?? null;
  if (raw == null) return null;
  return Number(raw);
}

/**
 * Raise `LlmQuotaExhausted` if the tenant's monthly usage plus the
 * projected call tokens would exceed the budget. `budget == null` means
 * unlimited.
 */
export async function checkBudget(
  tenant_id: string,
  projected_tokens: number,
  budget: number | null,
  exec?: Executor,
): Promise<void> {
  if (budget == null || budget <= 0) return;
  const used = await monthlyUsage(tenant_id, exec);
  if (used + projected_tokens > budget) {
    logger.warn({
      module: "llm",
      action: "llm.budget.exhausted",
      msg: "llm quota exhausted",
      tenant_id,
      used,
      projected_tokens,
      budget,
    });
    throw new LlmQuotaExhausted("llm_quota_exhausted", {
      used,
      projected_tokens,
      budget,
    });
  }
}

/**
 * Resolve the effective monthly budget for a tenant. A null return means the
 * tenant has no explicit cap and so is treated as unlimited.
 *
 * The cap lives in `tokens.monthly_budget`, the tenant-scoped runtime config
 * leaf, and nowhere else.
 *
 * It used to live in three places and be usable in none of them. The two
 * columns this used to read — `tenant_llm_settings.llm_monthly_token_budget`
 * and the legacy `tenants.llm_monthly_token_budget` — had two readers and
 * **no writer anywhere in the product**: the only way to set the cap that
 * actually returns 429 was manual SQL against an internal table. Meanwhile
 * the config leaf, described in the schema as "Hard cap on tokens consumed
 * per calendar month", editable in the settings surface, revisioned and
 * audited, was read by nothing. So the cockpit offered an operator a cap that
 * could not bite and hid the one that could.
 *
 * Now there is one: settable where it is shown, read where it is enforced.
 *
 * `0` is the schema default and means unlimited, which is why it maps to
 * `null` rather than to a cap of zero tokens — a cap of zero would refuse
 * every call on a fresh installation.
 */
export function resolveMonthlyBudget(tenant_id: string): number | null {
  // A caller on a path that runs before `loadConfig()` must not be refused
  // for want of a cap nobody set; an unreadable config is "no cap", the same
  // answer an unconfigured tenant gets.
  if (!isConfigLoaded()) return null;
  const raw = getConfig(tenant_id).tokens?.monthly_budget ?? 0;
  return raw > 0 ? raw : null;
}

/** How close a month's consumption is to its cap, as something a reader can act on. */
export type BudgetState = "ample" | "tightening" | "critical";

/** Share of the cap spent at which the month reads as tightening. */
export const BUDGET_TIGHTENING_SHARE = 0.75;
/** Share of the cap spent at which the month reads as critical. */
export const BUDGET_CRITICAL_SHARE = 0.9;

/**
 * The one reading of used-against-cap: the attention list's budget item, the
 * risk signal, `GET /v1/status`, `get_token_budget` and `sk health` all take
 * it from here, and the cockpit's usage page applies the same two shares.
 *
 * `null` when nothing bounds the month: an unbounded workspace is unmeasured,
 * not ample. The share is exact, never a rounded percentage — 89.6 % spent is
 * tightening everywhere, not critical on the one surface that rounded first.
 */
export function budgetState(used: number, budget: number | null): BudgetState | null {
  if (budget == null || budget <= 0) return null;
  const share = used / budget;
  if (share >= BUDGET_CRITICAL_SHARE) return "critical";
  if (share >= BUDGET_TIGHTENING_SHARE) return "tightening";
  return "ample";
}

/** A month's figures against one cap: used, cap, room left, and its state. */
export interface MonthlyBudgetFigures {
  month_bucket: number;
  used_tokens: number;
  budget_tokens: number | null;
  remaining_tokens: number | null;
  state: BudgetState | null;
}

export function monthlyBudgetFigures(used: number, budget: number | null): MonthlyBudgetFigures {
  return {
    month_bucket: currentMonthBucket(),
    used_tokens: used,
    budget_tokens: budget,
    remaining_tokens: budget == null ? null : Math.max(budget - used, 0),
    state: budgetState(used, budget),
  };
}

/** The workspace's month, as `GET /v1/status` and `get_token_budget` both report it. */
export async function readTenantMonthlyBudget(
  tenant_id: string,
  exec?: Executor,
): Promise<MonthlyBudgetFigures> {
  return monthlyBudgetFigures(await monthlyUsage(tenant_id, exec), resolveMonthlyBudget(tenant_id));
}

export interface CheckAndDecrementResult {
  ok: boolean;
  used: number;
  projected_tokens: number;
  budget: number | null;
  remaining: number | null;
  /** Which budget tripped when `ok` is false: the tenant cap or the
   *  per-user cap. Undefined when `ok` is true. */
  scope?: "tenant" | "user";
}

/**
 * Read the tenant's effective monthly budget (and, when `user_id` is
 * supplied, the per-user budget) and report whether an additional
 * `estimated_tokens` would still fit under BOTH. The tighter ceiling
 * wins, and `scope` names which one tripped.
 *
 * This helper is **read-only** — the actual decrement happens when the
 * provider records the usage row after the call completes, so concurrent
 * callers may both observe "ok" at the same instant. This is true for the
 * tenant path and the per-user path alike. The real guarantee is the audit
 * trail left by `recordUsage`, not a hard per-request reservation.
 */
export async function checkAndDecrement(
  tenant_id: string,
  estimated_tokens: number,
  exec?: Executor,
  user_id?: string | null,
): Promise<CheckAndDecrementResult> {
  const tenantBudget = resolveMonthlyBudget(tenant_id);
  const tenantUsed = await monthlyUsage(tenant_id, exec);
  const tenantUnlimited = tenantBudget == null || tenantBudget <= 0;
  const tenantOk = tenantUnlimited || tenantUsed + estimated_tokens <= tenantBudget;

  // Per-user cap is an ADDITIONAL ceiling, only when the actor is a user.
  if (user_id) {
    const userBudget = await resolveUserMonthlyBudget(tenant_id, user_id, exec);
    if (userBudget != null && userBudget > 0) {
      const userUsed = await monthlyUsageForUser(tenant_id, user_id, exec);
      const userOk = userUsed + estimated_tokens <= userBudget;
      if (!userOk) {
        return {
          ok: false,
          used: userUsed,
          projected_tokens: estimated_tokens,
          budget: userBudget,
          remaining: userBudget - userUsed,
          scope: "user",
        };
      }
    }
  }

  if (tenantUnlimited) {
    return {
      ok: true,
      used: tenantUsed,
      projected_tokens: estimated_tokens,
      budget: tenantBudget,
      remaining: null,
    };
  }
  const remaining = tenantBudget - tenantUsed;
  return {
    ok: tenantOk,
    used: tenantUsed,
    projected_tokens: estimated_tokens,
    budget: tenantBudget,
    remaining,
    ...(tenantOk ? {} : { scope: "tenant" as const }),
  };
}

/**
 * Persist a usage row. Always called after a provider call completes —
 * success, quota exhaustion, and provider error all land here.
 */
export async function recordUsage(entry: LlmCallLogEntry, exec?: Executor): Promise<void> {
  const db = exec ?? getDb();
  const bucket = currentMonthBucket();
  const cache_read_tokens = entry.cache_read_tokens ?? 0;
  const cache_creation_tokens = entry.cache_creation_tokens ?? 0;
  const total_tokens = weightedTotalTokens({
    prompt_tokens: entry.prompt_tokens,
    completion_tokens: entry.completion_tokens,
    cache_read_tokens,
    cache_creation_tokens,
  });
  await db.insert(llmUsage).values({
    tenant_id: entry.tenant_id,
    flow: entry.flow,
    model: entry.model,
    prompt_tokens: entry.prompt_tokens,
    completion_tokens: entry.completion_tokens,
    cache_read_tokens,
    cache_creation_tokens,
    total_tokens,
    latency_ms: entry.latency_ms,
    result: entry.result,
    error: entry.error ?? null,
    user_id: entry.user_id ?? null,
    actor_type: entry.actor_type ?? "system",
    month_bucket: bucket,
    execution_id: entry.execution_id ?? null,
    conversation_id: entry.conversation_id ?? null,
  });
}
