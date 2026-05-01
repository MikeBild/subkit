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

import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import { getMetrics, METRIC_NAMES } from "../../observability/metrics.ts";
import { recordUsage } from "../budgets.ts";
import type { SubkitLlmTelemetryMetadata, SubkitLlmUsage } from "./base-types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

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
    };
    if (cacheRead > 0) entry.cache_read_tokens = cacheRead;
    if (cacheCreate > 0) entry.cache_creation_tokens = cacheCreate;
    if (p.error !== undefined) entry.error = p.error;
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
 * `claude-*`, OpenAI's `gpt-*`, Google's `gemini-*` and a few others
 * are known prefixes; everything else lands as `other` so the
 * histogram label cardinality stays bounded.
 */
function inferProvider(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith("claude-") || m.includes("anthropic")) return "anthropic";
  if (m.startsWith("gpt-") || m.startsWith("o1-") || m.startsWith("o3-")) return "openai";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("mistral") || m.startsWith("mixtral")) return "mistral";
  if (m.startsWith("llama")) return "meta";
  return "other";
}
