// Token accountant — post-hoc reconciliation of SDK-reported usage into
// `llm_usage`.
//
// Why post-hoc: tiktoken (what `llm/tokens.ts` uses) and each provider's
// tokenizer drift by 10–15 %. Pre-call estimates drive *budget check*
// decisions; the accountant records the *actual* tokens reported by the
// SDK (`result.usage.inputTokens`, `result.usage.outputTokens`, plus
// cache-read / cache-creation from providerMetadata) so monthly usage
// sums match provider invoices.
//
// This module is a single seam around the existing `recordUsage` in
// `llm/budgets.ts` — it does not replace budget math, it just makes sure
// the row written reflects the SDK's numbers, not the tiktoken estimate.

import type { AuditActorType } from "../../audit/types.ts";
import type { Executor } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import { getMetrics, METRIC_NAMES } from "../../observability/metrics.ts";
import type { SubkitLlmTelemetryMetadata, SubkitLlmUsage } from "../core/base-types.ts";
import { recordUsage } from "./budget.ts";

/**
 * `llm_usage.execution_id` and `.conversation_id` are `uuid` columns fed from
 * free-form telemetry metadata. Guard the shape here rather than letting
 * Postgres raise inside the best-effort catch below, where the cost of a bad
 * value is the entire usage row rather than one missing attribution.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** The run and conversation a usage row belongs to, read from free-form
 *  telemetry metadata. Every row a call writes — the answer, a refused
 *  primary, a final error — links the same way. */
export function usageAttribution(metadata: Record<string, unknown> | undefined): {
  execution_id?: string;
  conversation_id?: string;
} {
  const out: { execution_id?: string; conversation_id?: string } = {};
  if (isUuid(metadata?.execution_id)) out.execution_id = metadata.execution_id;
  if (isUuid(metadata?.conversation_id)) out.conversation_id = metadata.conversation_id;
  return out;
}

export interface AccountParams {
  tenant_id: string;
  metadata: SubkitLlmTelemetryMetadata;
  model: string;
  usage: SubkitLlmUsage;
  latency_ms: number;
  result: "success" | "quota_exhausted" | "context_too_large" | "error";
  error?: string;
  /** Estimated tokens from the upfront tokenizer (for drift observation). */
  estimated_prompt_tokens?: number;
  /** Acting end-user, if any (null for system / system_account flows). */
  user_id?: string | null;
  /** Attribution class; defaults to "system" when omitted. */
  actor_type?: AuditActorType;
}

export interface AccountResult {
  drift_pct: number | null;
  recorded_input_tokens: number;
  recorded_output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

/**
 * Record one LLM call's usage into `llm_usage` and (when an estimate was
 * supplied) emit a drift log so operators can see the tiktoken ↔ SDK gap.
 * Pure I/O: does not raise on write failure — logs and swallows because
 * accounting errors must not fail a user-visible LLM response.
 */
export async function account(p: AccountParams, exec?: Executor): Promise<AccountResult> {
  const inputTokens = p.usage.input_tokens;
  const outputTokens = p.usage.output_tokens;
  const cacheRead = p.usage.cache_read_tokens;
  const cacheCreate = p.usage.cache_creation_tokens;

  let drift_pct: number | null = null;
  if (p.estimated_prompt_tokens !== undefined && p.estimated_prompt_tokens > 0) {
    const delta = Math.abs(p.estimated_prompt_tokens - inputTokens);
    drift_pct = delta / p.estimated_prompt_tokens;
    if (drift_pct > 0.1) {
      logger.debug({
        module: "llm",
        action: "token.drift",
        msg: "tiktoken estimate drifted from SDK usage by >10%",
        tenant_id: p.tenant_id,
        flow: p.metadata.flow,
        model: p.model,
        estimated: p.estimated_prompt_tokens,
        actual: inputTokens,
        drift_pct,
      });
    }
    // Always record the drift sample so the observability dashboard
    // can chart estimate quality at provider granularity. The
    // histogram buckets are 0..50 in percentage points.
    try {
      const provider = inferProvider(p.model);
      getMetrics().observe(METRIC_NAMES.LLM_TOKEN_DRIFT_PCT, Math.min(50, drift_pct * 100), {
        provider,
        model: p.model,
        kind: "prompt",
      });
    } catch {
      // Metric registry init can fail in tests that don't set up
      // observability; never fail accounting on it.
    }
  }

  try {
    const entry: Parameters<typeof recordUsage>[0] = {
      tenant_id: p.tenant_id,
      flow: p.metadata.flow,
      model: p.model,
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      latency_ms: p.latency_ms,
      result: p.result,
      user_id: p.user_id ?? null,
      actor_type: p.actor_type ?? "system",
    };
    if (cacheRead > 0) entry.cache_read_tokens = cacheRead;
    if (cacheCreate > 0) entry.cache_creation_tokens = cacheCreate;
    if (p.error !== undefined) entry.error = p.error;
    // `telemetry_metadata` is free-form, but these two keys are not telemetry
    // once they reach here — they become foreign keys. Both columns are
    // `uuid`, so a non-uuid string does not degrade to a bad reference, it
    // aborts the INSERT, and the catch below turns that into a lost row: the
    // provider bills the call and `llm_usage` never hears about it.
    //
    // Dropping an unusable id costs one attribution. Keeping it costs the
    // whole row.
    Object.assign(entry, usageAttribution(p.metadata));
    await recordUsage(entry, exec);
  } catch (err) {
    // Accounting is best-effort. A write failure must not mask the LLM
    // response itself — log and continue.
    logger.warn({
      module: "llm",
      action: "token.account_failed",
      msg: "token accountant failed to write llm_usage row",
      tenant_id: p.tenant_id,
      flow: p.metadata.flow,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    drift_pct,
    recorded_input_tokens: inputTokens,
    recorded_output_tokens: outputTokens,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreate,
  };
}

/**
 * Best-effort provider classification from a model id. Anthropic's
 * `claude-*`, OpenAI's `gpt-*`, Google's `gemini-*` plus common
 * open-weight families (`qwen`, `ministral`/`mistral`, `glm`, `deepseek`,
 * `llama`) are known prefixes; everything else lands as `other` so the
 * histogram label cardinality stays bounded. Exported for unit assertion.
 *
 * The open-weight family list mirrors `contextCapFor` in `count.ts` — when
 * adding a family here, add its context-window cap there too, and vice
 * versa, so telemetry labels and token budgets stay in lockstep.
 */
export function inferProvider(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith("claude-") || m.includes("anthropic")) return "anthropic";
  if (m.startsWith("gpt-") || m.startsWith("o1-") || m.startsWith("o3-")) return "openai";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("qwen")) return "qwen";
  if (m.startsWith("ministral") || m.startsWith("mistral") || m.startsWith("mixtral"))
    return "mistral";
  // Family-name label, consistent with the other open-weight buckets above
  // (`qwen`/`deepseek`); the publisher is Zhipu.
  if (m.startsWith("glm")) return "glm";
  if (m.startsWith("deepseek")) return "deepseek";
  if (m.startsWith("llama")) return "meta";
  return "other";
}
