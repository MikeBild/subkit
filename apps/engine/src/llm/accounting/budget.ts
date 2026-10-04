import { and, eq, sql } from "drizzle-orm";
import { getConfig, isConfigLoaded } from "../../config/loader.ts";
import { type Executor, getDb } from "../../db/client.ts";
import { llmUsage, userLlmSettings } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { LlmQuotaExhausted } from "../errors.ts";
import { billedTokenUsage, weightedTotalTokens } from "../pricing.ts";
import type { LlmCallLogEntry } from "../types.ts";

export function currentMonthBucket(d: Date = new Date()): number {
  return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);
}

export async function monthlyUsage(tenant_id: string, exec?: Executor): Promise<number> {
  const db = exec ?? getDb();
  const bucket = currentMonthBucket();
  const out = await db
    .select({ total: sql<number>`coalesce(sum(${llmUsage.total_tokens}), 0)::int` })
    .from(llmUsage)
    .where(and(eq(llmUsage.tenant_id, tenant_id), eq(llmUsage.month_bucket, bucket)));
  return Number(out[0]?.total ?? 0);
}

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

export function resolveMonthlyBudget(tenant_id: string): number | null {
  if (!isConfigLoaded()) return null;
  const raw = getConfig(tenant_id).tokens?.monthly_budget ?? 0;
  return raw > 0 ? raw : null;
}

export type BudgetState = "ample" | "tightening" | "critical";

export const BUDGET_TIGHTENING_SHARE = 0.75;
export const BUDGET_CRITICAL_SHARE = 0.9;

export function budgetState(used: number, budget: number | null): BudgetState | null {
  if (budget == null || budget <= 0) return null;
  const share = used / budget;
  if (share >= BUDGET_CRITICAL_SHARE) return "critical";
  if (share >= BUDGET_TIGHTENING_SHARE) return "tightening";
  return "ample";
}

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
  scope?: "tenant" | "user";
}

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

export async function recordUsage(entry: LlmCallLogEntry, exec?: Executor): Promise<void> {
  const db = exec ?? getDb();
  const bucket = currentMonthBucket();
  const billed = billedTokenUsage({
    result: entry.result,
    prompt_tokens: entry.prompt_tokens,
    completion_tokens: entry.completion_tokens,
    cache_read_tokens: entry.cache_read_tokens ?? 0,
    cache_creation_tokens: entry.cache_creation_tokens ?? 0,
  });
  const total_tokens = weightedTotalTokens(billed);
  await db.insert(llmUsage).values({
    tenant_id: entry.tenant_id,
    flow: entry.flow,
    model: entry.model,
    prompt_tokens: billed.prompt_tokens,
    completion_tokens: billed.completion_tokens,
    cache_read_tokens: billed.cache_read_tokens,
    cache_creation_tokens: billed.cache_creation_tokens,
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
