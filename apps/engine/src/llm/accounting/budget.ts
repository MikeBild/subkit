import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Executor, getDb } from "../../db/client.ts";
import { llmUsage, tenants } from "../../db/schema/index.ts";
import { cacheWeightsFor } from "../model-price-catalog.ts";
import { billedTokenUsage, weightedTotalTokens } from "../pricing.ts";
import type { LlmCallLogEntry } from "../types.ts";
import { spendRefusalDetails, spendVerdict } from "./spend.ts";

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
        eq(llmUsage.actor_type, "user"),
        eq(llmUsage.month_bucket, bucket),
      ),
    );
  return Number(out[0]?.total ?? 0);
}

export interface CheckAndDecrementResult {
  ok: boolean;
  used: number;
  projected_tokens: number;
  scope?: "spend";
  spend?: Record<string, unknown>;
}

export async function checkAndDecrement(
  tenant_id: string,
  estimated_tokens: number,
  exec?: Executor,
): Promise<CheckAndDecrementResult> {
  const [spend, used] = await Promise.all([
    spendVerdict(tenant_id, { kind: "flow", flow: "any" }, exec),
    monthlyUsage(tenant_id, exec),
  ]);
  if (spend.ok) return { ok: true, used, projected_tokens: estimated_tokens };
  return {
    ok: false,
    used,
    projected_tokens: estimated_tokens,
    scope: "spend",
    spend: spendRefusalDetails(spend.reading),
  };
}

export async function recordUsage(entry: LlmCallLogEntry, exec?: Executor): Promise<void> {
  const db = exec ?? getDb();
  const bucket = currentMonthBucket();
  const [tenant] = await db
    .select({ origin: tenants.origin })
    .from(tenants)
    .where(eq(tenants.id, entry.tenant_id))
    .limit(1);
  const hosted = tenant?.origin === "self_service";
  if (hosted) {
    z.enum([
      "generate",
      "extract",
      "catalog_describe",
      "repair",
      "tool_repair",
      "converse",
      "discover",
      "summarize",
      "suggest_next",
      "critic_authoring",
      "judge",
      "workflow_step",
      "personal_notes",
    ]).parse(entry.flow);
    z.string()
      .regex(/^[a-zA-Z0-9._:@/+-]{1,200}$/)
      .parse(entry.model);
    z.enum(["success", "quota_exhausted", "context_too_large", "key_rejected", "error"]).parse(
      entry.result,
    );
    z.enum(["system", "user", "system_account"]).parse(entry.actor_type ?? "system");
  }
  const billed = billedTokenUsage({
    result: entry.result,
    prompt_tokens: entry.prompt_tokens,
    completion_tokens: entry.completion_tokens,
    cache_read_tokens: entry.cache_read_tokens ?? 0,
    cache_creation_tokens: entry.cache_creation_tokens ?? 0,
  });
  const total_tokens = weightedTotalTokens(billed, cacheWeightsFor(entry.model));
  await db.insert(llmUsage).values({
    tenant_id: entry.tenant_id,
    flow: entry.flow,
    model: entry.model,
    prompt_tokens: billed.prompt_tokens,
    completion_tokens: billed.completion_tokens,
    cache_read_tokens: billed.cache_read_tokens,
    cache_creation_tokens: billed.cache_creation_tokens,
    cache_reported: entry.cache_reported ?? null,
    total_tokens,
    latency_ms: entry.latency_ms,
    result: entry.result,
    error: entry.error == null ? null : hosted ? "provider_error" : entry.error,
    user_id: entry.user_id ?? null,
    actor_type: entry.actor_type ?? "system",
    month_bucket: bucket,
    execution_id: entry.execution_id ?? null,
    conversation_id: entry.conversation_id ?? null,
  });
}
