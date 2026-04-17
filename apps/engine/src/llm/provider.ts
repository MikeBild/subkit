// LLM provider layer.
//
// Tenant-aware model routing:
//   1. `resolveModelRoute(tenant_id)` reads `tenant_llm_settings`, falls
//      back to the P1 `tenants` llm_* columns, then to env
//      `LLM_PRIMARY` / `LLM_FALLBACK`. Default primary is
//      `claude-sonnet-4-5`, fallback is `claude-haiku-4-5-20251001`.
//   2. `callWithFallback(...)` runs the primary; on rate_limit /
//      overloaded / context_length_exceeded it retries on the fallback
//      exactly once.
//   3. Every attempt writes an `llm_usage` row (success or error) so
//      the budget accountant and operator debugger both have a full
//      history.
//
// Tests set `LLM_PROVIDER=mock` (or the per-tenant `llm_provider`) so
// the mock provider handles the call in-process. The real Anthropic SDK
// is only wired when `env.ANTHROPIC_API_KEY` is set AND the effective
// provider is not 'mock'.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createProviderRegistry, generateObject, generateText, NoObjectGeneratedError } from "ai";
import { and, eq } from "drizzle-orm";
import type { ZodType } from "zod";
import { type Db, getDb } from "../db/client.ts";
import { tenantLlmSettings, tenants } from "../db/schema/index.ts";
import { env } from "../env.ts";
import { logger } from "../logging/logger.ts";
import { recordLlmQuotaExhausted, recordLlmTokens } from "../observability/instrumentation.ts";
import { checkAndDecrement, checkBudget, recordUsage } from "./budgets.ts";
import { LlmProviderError, LlmQuotaExhausted } from "./errors.ts";
import { getMockProvider, type MockResult } from "./mock-provider.ts";
import { contextCapFor } from "./tokens.ts";
import type { EnhancedPrompt, LlmFlow, LlmProviderKind, ModelRoute } from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const DEFAULT_PRIMARY = "claude-sonnet-4-5";
const DEFAULT_FALLBACK = "claude-haiku-4-5-20251001";

function currentProvider(): LlmProviderKind {
  const raw = (process.env.LLM_PROVIDER ?? "").toLowerCase();
  if (
    raw === "anthropic" ||
    raw === "openai" ||
    raw === "bedrock" ||
    raw === "vertex" ||
    raw === "azure" ||
    raw === "mock"
  ) {
    return raw;
  }
  // Default: prefer anthropic when the API key is set, else mock for
  // local-first/test friendliness.
  return env.ANTHROPIC_API_KEY ? "anthropic" : "mock";
}

// Single provider registry. `registry.languageModel("anthropic:claude-...")`
// handles the `provider:model` prefix natively; we no longer need to
// hand-strip a leading "anthropic:" on model ids.
const anthropicProvider = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY ?? "" });
export const modelRegistry = createProviderRegistry({ anthropic: anthropicProvider });

function anthropicModel(modelId: string): ReturnType<typeof anthropicProvider.languageModel> {
  // Strip any `anthropic:` prefix the registry would otherwise consume,
  // so tenant-configured model ids (which may or may not carry one) all
  // resolve against our single Anthropic provider instance.
  const bare = modelId.startsWith("anthropic:") ? modelId.slice("anthropic:".length) : modelId;
  return anthropicProvider.languageModel(bare);
}

export async function resolveModelRoute(tenant_id: string, exec?: Executor): Promise<ModelRoute> {
  const db = exec ?? getDb();

  // Preferred source: normalised tenant_llm_settings row.
  const settingsRows = await db
    .select()
    .from(tenantLlmSettings)
    .where(eq(tenantLlmSettings.tenant_id, tenant_id))
    .limit(1);
  const settings = settingsRows[0];

  // Fallback: the P1-era `tenants.llm_*` columns.
  const tenantRows = await db
    .select()
    .from(tenants)
    .where(and(eq(tenants.id, tenant_id)))
    .limit(1);
  const tenant = tenantRows[0];

  const primary =
    settings?.llm_primary_model ?? tenant?.llm_primary ?? env.LLM_PRIMARY ?? DEFAULT_PRIMARY;
  const fallback =
    settings?.llm_fallback_model ?? tenant?.llm_fallback ?? env.LLM_FALLBACK ?? DEFAULT_FALLBACK;
  const provider = (settings?.llm_provider as LlmProviderKind | undefined) ?? currentProvider();
  const monthly_budget =
    settings?.llm_monthly_token_budget ??
    (tenant?.llm_monthly_token_budget != null ? Number(tenant.llm_monthly_token_budget) : null);

  return {
    tenant_id,
    primary,
    fallback,
    provider,
    context_cap: contextCapFor(primary),
    monthly_budget,
    enable_prompt_cache: settings?.enable_prompt_cache ?? false,
  };
}

interface CallArgs<T = unknown> {
  flow: LlmFlow;
  route: ModelRoute;
  prompt: EnhancedPrompt;
  /**
   * When set, the flow wants a validated, typed object. `generateObject`
   * replaces `generateText` and the SDK enforces the schema — an
   * `AI_NoObjectGeneratedError` propagates on validation failure instead
   * of silent extraction.
   */
  schema?: ZodType<T>;
  /**
   * Optional conversation id / correlation id for telemetry metadata.
   * Landed in OTel span attributes via `experimental_telemetry`.
   */
  telemetry_metadata?: Record<string, string | number | boolean>;
}

function shouldFallback(err: unknown): boolean {
  if (!(err instanceof LlmProviderError)) return false;
  return (
    err.kind === "rate_limit" || err.kind === "overloaded" || err.kind === "context_length_exceeded"
  );
}

interface AnthropicUsageRaw {
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Pull `cache_read_input_tokens` / `cache_creation_input_tokens` out of
 * Anthropic's raw usage payload. These land in
 * `providerMetadata.anthropic.usage` as a JSON blob; the AI SDK v6 type
 * models the field as `JSONObject` so we narrow here.
 */
function extractCacheTokens(providerMetadata: Record<string, unknown> | undefined): {
  cache_read_tokens: number;
  cache_creation_tokens: number;
} {
  const anthropicMeta = (providerMetadata?.anthropic ?? {}) as {
    usage?: AnthropicUsageRaw;
    cacheCreationInputTokens?: number | null;
  };
  const raw = anthropicMeta.usage ?? {};
  return {
    cache_read_tokens: Number(raw.cache_read_input_tokens ?? 0),
    cache_creation_tokens: Number(
      raw.cache_creation_input_tokens ?? anthropicMeta.cacheCreationInputTokens ?? 0,
    ),
  };
}

/**
 * Build the system-message array. When `enable_prompt_cache` is set on
 * the route we attach an Anthropic `ephemeral` cache breakpoint to the
 * system message so the stable context (skills palette + ingested docs)
 * is reused across calls and re-billed at ~10 % of its input cost.
 *
 * Caching is currently applied to the whole assembled system string —
 * the A5 follow-up will split `EnhancedPrompt.system` into stable vs
 * turn-specific blocks to narrow the cached region further.
 */
function buildSystem(
  prompt: EnhancedPrompt,
  enable_cache: boolean,
): Array<{
  role: "system";
  content: string;
  providerOptions?: { anthropic: { cacheControl: { type: "ephemeral"; ttl?: "5m" | "1h" } } };
}> {
  if (prompt.system.length === 0) return [];
  const base = { role: "system" as const, content: prompt.system };
  if (!enable_cache) return [base];
  return [
    {
      ...base,
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
      },
    },
  ];
}

async function dispatchAnthropic<T>(model: string, args: CallArgs<T>): Promise<MockResult<T>> {
  const system = buildSystem(args.prompt, args.route.enable_prompt_cache);
  const messages = args.prompt.messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const telemetry = {
    isEnabled: true as const,
    functionId: args.flow,
    metadata: {
      tenant_id: args.route.tenant_id,
      model,
      provider: args.route.provider,
      ...(args.telemetry_metadata ?? {}),
    },
  };

  if (args.schema) {
    const result = await generateObject({
      model: anthropicModel(model),
      ...(system.length > 0 ? { system } : {}),
      messages,
      schema: args.schema,
      abortSignal: AbortSignal.timeout(120_000),
      maxRetries: 0,
      experimental_telemetry: telemetry,
    });
    const cache = extractCacheTokens(result.providerMetadata);
    return {
      text: JSON.stringify(result.object),
      object: result.object as T,
      prompt_tokens: result.usage?.inputTokens ?? args.prompt.token_counts.total,
      completion_tokens: result.usage?.outputTokens ?? 0,
      cache_read_tokens: cache.cache_read_tokens,
      cache_creation_tokens: cache.cache_creation_tokens,
    };
  }

  const result = await generateText({
    model: anthropicModel(model),
    ...(system.length > 0 ? { system } : {}),
    messages,
    abortSignal: AbortSignal.timeout(120_000),
    maxRetries: 0,
    experimental_telemetry: telemetry,
  });
  const cache = extractCacheTokens(result.providerMetadata);
  return {
    text: result.text,
    object: (args.flow === "converse" ? undefined : extractJson<T>(result.text)) as T,
    prompt_tokens: result.usage?.inputTokens ?? args.prompt.token_counts.total,
    completion_tokens: result.usage?.outputTokens ?? 0,
    cache_read_tokens: cache.cache_read_tokens,
    cache_creation_tokens: cache.cache_creation_tokens,
  };
}

function extractJson<T>(text: string): T | undefined {
  // Try direct parse first (model obeyed "no surrounding prose").
  try {
    return JSON.parse(text) as T;
  } catch {
    // Fall through — try to extract from markdown code fences.
  }
  // Extract from ```json ... ``` or ``` ... ``` blocks.
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1]) as T;
    } catch {
      // Fall through.
    }
  }
  // Last resort: find the first { ... } or [ ... ] blob.
  const braceStart = text.indexOf("{");
  const bracketStart = text.indexOf("[");
  const start =
    braceStart >= 0 && (bracketStart < 0 || braceStart < bracketStart) ? braceStart : bracketStart;
  if (start >= 0) {
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    const end = text.lastIndexOf(close);
    if (end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as T;
      } catch {
        // Give up.
      }
    }
  }
  return undefined;
}

async function dispatch<T>(model: string, args: CallArgs<T>): Promise<MockResult<T>> {
  if (args.route.provider === "mock") {
    return getMockProvider().call<T>({
      flow: args.flow,
      model,
      prompt: args.prompt,
    });
  }
  try {
    return await dispatchAnthropic<T>(model, args);
  } catch (err) {
    // `AI_NoObjectGeneratedError` escapes unchanged so the HTTP error
    // mapper can surface it as a 502 without wrapping. Everything else
    // collapses into the provider-kind classification used by the
    // fallback policy.
    if (NoObjectGeneratedError.isInstance(err)) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("rate_limit") || msg.includes("429")) {
      throw new LlmProviderError("rate_limit", msg);
    }
    if (msg.includes("overloaded") || msg.includes("529")) {
      throw new LlmProviderError("overloaded", msg);
    }
    if (msg.includes("context_length") || msg.includes("too many tokens")) {
      throw new LlmProviderError("context_length_exceeded", msg);
    }
    throw new LlmProviderError("other", msg);
  }
}

/**
 * Run the call against the primary model; on fallback-eligible errors
 * retry once against the fallback model. Writes one llm_usage row per
 * attempt. Per-tenant budget is checked before the first attempt.
 */
export async function callWithFallback<T = unknown>(
  args: CallArgs<T>,
  exec?: Executor,
): Promise<{ result: MockResult<T>; model_used: string; fell_back: boolean }> {
  const db = exec ?? getDb();
  const estimated = args.prompt.token_counts.total + 1024;

  // Pre-check budget. The GC6 `checkAndDecrement` helper resolves the
  // effective budget from `tenant_llm_settings` and reports whether the
  // projected call still fits under the monthly cap. The route-level
  // `monthly_budget` is honored as an override — if either check fails
  // we raise `LlmQuotaExhausted` so the caller sees the quota error.
  try {
    await checkBudget(args.route.tenant_id, estimated, args.route.monthly_budget, db);
    const verdict = await checkAndDecrement(args.route.tenant_id, estimated, db);
    if (!verdict.ok) {
      throw new LlmQuotaExhausted("llm_quota_exhausted", {
        used: verdict.used,
        projected_tokens: verdict.projected_tokens,
        budget: verdict.budget,
        remaining: verdict.remaining,
      });
    }
  } catch (err) {
    if (err instanceof LlmQuotaExhausted) {
      await recordUsage(
        {
          tenant_id: args.route.tenant_id,
          flow: args.flow,
          model: args.route.primary,
          prompt_tokens: args.prompt.token_counts.total,
          completion_tokens: 0,
          latency_ms: 0,
          result: "quota_exhausted",
          error: "llm_quota_exhausted",
        },
        db,
      );
      recordLlmQuotaExhausted({ tenant_id: args.route.tenant_id });
    }
    throw err;
  }

  const start = Date.now();
  try {
    const primaryResult = await dispatch<T>(args.route.primary, args);
    const latency = Date.now() - start;
    logger.info({
      module: "llm",
      action: "call",
      msg: "llm call completed",
      flow: args.flow,
      model: args.route.primary,
      prompt_tokens: primaryResult.prompt_tokens,
      completion_tokens: primaryResult.completion_tokens,
      cache_read_tokens: primaryResult.cache_read_tokens ?? 0,
      cache_creation_tokens: primaryResult.cache_creation_tokens ?? 0,
      latency_ms: latency,
      result: "success",
    });
    await recordUsage(
      {
        tenant_id: args.route.tenant_id,
        flow: args.flow,
        model: args.route.primary,
        prompt_tokens: primaryResult.prompt_tokens,
        completion_tokens: primaryResult.completion_tokens,
        ...(primaryResult.cache_read_tokens !== undefined
          ? { cache_read_tokens: primaryResult.cache_read_tokens }
          : {}),
        ...(primaryResult.cache_creation_tokens !== undefined
          ? { cache_creation_tokens: primaryResult.cache_creation_tokens }
          : {}),
        latency_ms: latency,
        result: "success",
      },
      db,
    );
    recordLlmTokens({
      tenant_id: args.route.tenant_id,
      model: args.route.primary,
      flow: args.flow,
      prompt_tokens: primaryResult.prompt_tokens,
      completion_tokens: primaryResult.completion_tokens,
    });
    return { result: primaryResult, model_used: args.route.primary, fell_back: false };
  } catch (err) {
    const latency = Date.now() - start;
    const kind = err instanceof LlmProviderError ? err.kind : "other";
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({
      module: "llm",
      action: "call.failed",
      msg: "llm primary call failed",
      flow: args.flow,
      model: args.route.primary,
      kind,
      latency_ms: latency,
      error: msg,
    });
    await recordUsage(
      {
        tenant_id: args.route.tenant_id,
        flow: args.flow,
        model: args.route.primary,
        prompt_tokens: args.prompt.token_counts.total,
        completion_tokens: 0,
        latency_ms: latency,
        result: "error",
        error: msg,
      },
      db,
    );
    if (!shouldFallback(err)) {
      throw err;
    }
    logger.warn({
      module: "llm",
      action: "fallback.triggered",
      msg: "llm fallback engaged",
      flow: args.flow,
      primary: args.route.primary,
      fallback: args.route.fallback,
      kind,
    });
    const fbStart = Date.now();
    try {
      const fbResult = await dispatch<T>(args.route.fallback, args);
      const fbLatency = Date.now() - fbStart;
      logger.info({
        module: "llm",
        action: "call",
        msg: "llm fallback call completed",
        flow: args.flow,
        model: args.route.fallback,
        prompt_tokens: fbResult.prompt_tokens,
        completion_tokens: fbResult.completion_tokens,
        cache_read_tokens: fbResult.cache_read_tokens ?? 0,
        cache_creation_tokens: fbResult.cache_creation_tokens ?? 0,
        latency_ms: fbLatency,
        result: "success",
      });
      await recordUsage(
        {
          tenant_id: args.route.tenant_id,
          flow: args.flow,
          model: args.route.fallback,
          prompt_tokens: fbResult.prompt_tokens,
          completion_tokens: fbResult.completion_tokens,
          ...(fbResult.cache_read_tokens !== undefined
            ? { cache_read_tokens: fbResult.cache_read_tokens }
            : {}),
          ...(fbResult.cache_creation_tokens !== undefined
            ? { cache_creation_tokens: fbResult.cache_creation_tokens }
            : {}),
          latency_ms: fbLatency,
          result: "success",
        },
        db,
      );
      recordLlmTokens({
        tenant_id: args.route.tenant_id,
        model: args.route.fallback,
        flow: args.flow,
        prompt_tokens: fbResult.prompt_tokens,
        completion_tokens: fbResult.completion_tokens,
      });
      return { result: fbResult, model_used: args.route.fallback, fell_back: true };
    } catch (fbErr) {
      const fbLatency = Date.now() - fbStart;
      const fbMsg = fbErr instanceof Error ? fbErr.message : String(fbErr);
      await recordUsage(
        {
          tenant_id: args.route.tenant_id,
          flow: args.flow,
          model: args.route.fallback,
          prompt_tokens: args.prompt.token_counts.total,
          completion_tokens: 0,
          latency_ms: fbLatency,
          result: "error",
          error: fbMsg,
        },
        db,
      );
      throw fbErr;
    }
  }
}
