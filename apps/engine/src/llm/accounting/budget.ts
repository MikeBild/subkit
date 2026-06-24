// Per-tenant monthly token budget accounting.
//
// Reads sum over `llm_usage.month_bucket = YYYYMM`. The ledger is
// append-only; every call writes one row regardless of outcome so
// operators can audit every LLM interaction against the budget.

import { and, eq, sql } from "drizzle-orm";
import { type Executor, getDb } from "../../db/client.ts";
import { llmUsage, tenantLlmSettings, userLlmSettings } from "../../db/schema/index.ts";
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
 * Resolve the effective monthly budget for a tenant from
 * `tenant_llm_settings.llm_monthly_token_budget`. A null return means
 * the tenant has no explicit cap and so is treated as unlimited.
 */
export async function resolveMonthlyBudget(
  tenant_id: string,
  exec?: Executor,
): Promise<number | null> {
  const db = exec ?? getDb();
  const rows = await db
    .select({ budget: tenantLlmSettings.llm_monthly_token_budget })
    .from(tenantLlmSettings)
    .where(eq(tenantLlmSettings.tenant_id, tenant_id))
    .limit(1);
  const raw = rows[0]?.budget ?? null;
  if (raw == null) return null;
  return Number(raw);
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
  const tenantBudget = await resolveMonthlyBudget(tenant_id, exec);
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
