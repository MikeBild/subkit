import type { KnownAuditActorType } from "../../audit/types.ts";
import type { Executor } from "../../db/client.ts";
import { logger } from "../../logging/index.ts";
import { getMetrics, METRIC_NAMES } from "../../observability/metrics.ts";
import { isUuid } from "../../utils/index.ts";
import type { SubkitLlmTelemetryMetadata, SubkitLlmUsage } from "../runtime/base-types.ts";
import { recordUsage } from "./budget.ts";

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
  result: "success" | "quota_exhausted" | "context_too_large" | "key_rejected" | "error";
  error?: string;
  estimated_prompt_tokens?: number;
  user_id?: string | null;
  actor_type?: KnownAuditActorType;
}

export interface AccountResult {
  drift_pct: number | null;
  recorded_input_tokens: number;
  recorded_output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

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
    try {
      const provider = inferProvider(p.model);
      getMetrics().observe(METRIC_NAMES.LLM_TOKEN_DRIFT_PCT, Math.min(50, drift_pct * 100), {
        provider,
        model: p.model,
        kind: "prompt",
      });
    } catch {}
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
    if (p.usage.cache_reported !== undefined) entry.cache_reported = p.usage.cache_reported;
    if (p.error !== undefined) entry.error = p.error;
    Object.assign(entry, usageAttribution(p.metadata));
    await recordUsage(entry, exec);
  } catch (err) {
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

export function inferProvider(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith("claude-") || m.includes("anthropic")) return "anthropic";
  if (m.startsWith("gpt-") || m.startsWith("o1-") || m.startsWith("o3-")) return "openai";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("qwen")) return "qwen";
  if (m.startsWith("ministral") || m.startsWith("mistral") || m.startsWith("mixtral"))
    return "mistral";
  if (m.startsWith("glm")) return "glm";
  if (m.startsWith("deepseek")) return "deepseek";
  if (m.startsWith("llama")) return "meta";
  return "other";
}
