// `invoke` — single entry point for every LLM call in the engine.
//
// Responsibilities (in order):
//   1) Resolve per-tenant model route (primary/fallback, provider, budget,
//      cache-toggle) from `tenant_llm_settings` + env fallback.
//   2) Budget pre-check and decrement via `llm/accounting/budget.ts`.
//   3) Assemble context via `core/context-assembler.ts` → stable/volatile
//      cache blocks + a budget report.
//   4) Dispatch:
//        provider === "mock" → in-process mock provider (tests)
//        otherwise            → AiSdkModel (gateway-first, via `ai`)
//   5) Post-hoc reconcile SDK-reported usage into `llm_usage` via
//      `llm/accounting/accountant.ts`.
//   6) Return a uniform `{result, prompt, blocks, budget_report,
//      model_used, fell_back}` envelope.
//
// This file is the only place the engine touches either the AiSdkModel
// or the mock provider directly. All four flows (generate, extract,
// repair, converse) are thin wrappers around `invoke`.

import type { LanguageModel } from "ai";
import { and, eq } from "drizzle-orm";
import { type ZodType, z } from "zod";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { getConfig } from "../../config/loader.ts";
import { type Db, getDb } from "../../db/client.ts";
import { tenantLlmSettings, tenants } from "../../db/schema/index.ts";
import { log, logger } from "../../logging/logger.ts";
import {
  recordLlmCacheUsage,
  recordLlmQuotaExhausted,
  recordLlmTokens,
} from "../../observability/instrumentation.ts";
import {
  account,
  checkAndDecrement,
  checkBudget,
  contextCapFor,
  recordUsage,
} from "../accounting/index.ts";
import { LlmProviderError, LlmQuotaExhausted } from "../errors.ts";
import { getMockProvider, type MockResult } from "../mock-provider.ts";
import { classifyProviderError, isFallbackEligible } from "../provider-errors.ts";
import type { LlmFlow, LlmProviderKind, ModelRoute, UserTurn } from "../types.ts";
import { AiSdkModel } from "./ai-sdk-model.ts";
import type { SubkitLlmMessage } from "./base-types.ts";
import { toSystemMessages } from "./cache-blocks.ts";
import { type AssembledContext, assembleContext } from "./context-assembler.ts";
import { maybeWrapForDevtools } from "./devtools-wrap.ts";
import { detectConfiguredProvider, initializeModel } from "./model-init.ts";
import { safeParseJson } from "./safe-json.ts";

/**
 * Resolve the Vercel AI SDK model handle for the given model id. Real-LLM
 * paths route through the AI Gateway (AI_GATEWAY_API_KEY); mock paths
 * return the sentinel string which the conversation loop short-circuits
 * before dispatch.
 *
 * Model ids prefixed `anthropic:`, `openai:`, etc. are stripped — the `ai`
 * SDK routes on the plain model string via the gateway, so `anthropic:` is
 * just a namespacing nicety that lived in tenant routes.
 */
export async function resolveLanguageModel(
  provider: LlmProviderKind,
  modelId: string,
): Promise<LanguageModel | string> {
  const bare = modelId.includes(":") ? modelId.slice(modelId.indexOf(":") + 1) : modelId;
  const resolved = await initializeModel({
    providerOverride: provider,
    defaultModel: bare,
    modelOverride: bare,
  });
  return await maybeWrapForDevtools(resolved.model);
}

function zodToJson(schema: ZodType): Record<string, unknown> {
  // Zod v4 ships a native JSON-Schema exporter. Pin to the "strict" target
  // so object shapes are deterministic (no `anyOf` unions for optional
  // fields — we want `required: [...]` arrays).
  // biome-ignore lint/suspicious/noExplicitAny: zod v4 type surface
  return (z as any).toJSONSchema(schema, { target: "jsonSchema7" });
}

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const DEFAULT_PRIMARY = "claude-sonnet-4-5";
const DEFAULT_FALLBACK = "claude-haiku-4-5-20251001";

/**
 * Snapshot of the global LLM-routing configuration for /v1/health.
 *
 * Surfaces both the env (`LLM_PROVIDER`) and the inferred provider so
 * operators can spot the regression that caused the production
 * `internal_error` cluster: env unset, key present, inferred provider
 * mismatching the dispatch-time fallback.
 */
export interface GlobalLlmStatus {
  provider_env: string | null;
  inferred_provider: LlmProviderKind | "unconfigured";
  fallback_provider_env: string | null;
  fallback_inferred_provider: LlmProviderKind | "unconfigured";
  summarize_provider_env: string | null;
  summarize_inferred_provider: LlmProviderKind | "unconfigured";
  summarize_model: string | null;
  summarize_configuration_error: string | null;
  gateway_key_set: boolean;
  gateway_model_set: boolean;
  anthropic_key_set: boolean;
  openai_key_set: boolean;
  gemini_key_set: boolean;
  azure_key_set: boolean;
  bedrock_key_set: boolean;
  vertex_api_key_set: boolean;
  vertex_service_account_set: boolean;
  configuration_error: string | null;
  default_primary: string;
  default_fallback: string;
}

export function globalLlmStatus(): GlobalLlmStatus {
  const cfg = getConfig().llm;
  const inferred = detectConfiguredProvider();
  const fallbackInferred = detectConfiguredProvider({ providerEnvVar: "LLM_FALLBACK_PROVIDER" });
  const summarizeProviderEnvVar = cfg.summarize_provider
    ? "SUMMARIZE_LLM_PROVIDER"
    : "LLM_PROVIDER";
  const summarizeInferred = detectConfiguredProvider({ providerEnvVar: summarizeProviderEnvVar });
  const providers = cfg.providers;
  const bedrock = providers.bedrock;
  const vertex = providers.vertex;
  return {
    provider_env: cfg.provider || null,
    inferred_provider: inferred,
    fallback_provider_env: cfg.fallback_provider ?? null,
    fallback_inferred_provider: fallbackInferred,
    summarize_provider_env: cfg.summarize_provider ?? null,
    summarize_inferred_provider: summarizeInferred,
    summarize_model: cfg.summarize_model || null,
    summarize_configuration_error: null,
    gateway_key_set: Boolean(providers.ai_gateway.api_key),
    gateway_model_set: Boolean(providers.ai_gateway.model),
    anthropic_key_set: Boolean(providers.anthropic.api_key),
    openai_key_set: Boolean(providers.openai.api_key),
    gemini_key_set: Boolean(providers.gemini.api_key),
    azure_key_set: Boolean(providers.azure.api_key),
    bedrock_key_set: Boolean(bedrock.access_key_id && bedrock.secret_access_key && bedrock.region),
    vertex_api_key_set: Boolean(vertex.api_key),
    vertex_service_account_set: Boolean(vertex.client_email && vertex.private_key),
    configuration_error: null,
    default_primary: cfg.model || DEFAULT_PRIMARY,
    default_fallback: cfg.fallback_model || DEFAULT_FALLBACK,
  };
}

function currentProvider(): LlmProviderKind {
  const detected = detectConfiguredProvider();
  return detected === "unconfigured" ? "gateway" : detected;
}

function currentFallbackProvider(primaryProvider: LlmProviderKind): LlmProviderKind {
  const detected = detectConfiguredProvider({ providerEnvVar: "LLM_FALLBACK_PROVIDER" });
  return detected === "unconfigured" ? primaryProvider : detected;
}

export async function resolveModelRoute(tenant_id: string, exec?: Executor): Promise<ModelRoute> {
  const db = exec ?? getDb();

  const settingsRows = await db
    .select()
    .from(tenantLlmSettings)
    .where(eq(tenantLlmSettings.tenant_id, tenant_id))
    .limit(1);
  const settings = settingsRows[0];

  const tenantRows = await db
    .select()
    .from(tenants)
    .where(and(eq(tenants.id, tenant_id)))
    .limit(1);
  const tenant = tenantRows[0];

  // v3.5: llm.model / llm.fallback_model are first-class config leaves.
  // The pre-v3.5 LLM_PRIMARY / LLM_FALLBACK env reads are retired
  // (see RETIRED_ENV_KEYS in env.ts) — operators who still set them
  // get a warn at boot. Resolution chain: per-conversation settings →
  // tenant override → schema-config → DEFAULT_*.
  let cfgModel: string | undefined;
  let cfgFallback: string | undefined;
  try {
    const cfg = getConfig().llm;
    if (cfg.model) cfgModel = cfg.model;
    if (cfg.fallback_model) cfgFallback = cfg.fallback_model;
  } catch {
    /* loader not initialised — unit tests fall back to DEFAULT_* */
  }
  const primary = settings?.llm_primary_model ?? tenant?.llm_primary ?? cfgModel ?? DEFAULT_PRIMARY;
  const fallback =
    settings?.llm_fallback_model ?? tenant?.llm_fallback ?? cfgFallback ?? DEFAULT_FALLBACK;
  const provider = (settings?.llm_provider as LlmProviderKind | undefined) ?? currentProvider();
  const fallback_provider = currentFallbackProvider(provider);
  const monthly_budget =
    settings?.llm_monthly_token_budget ??
    (tenant?.llm_monthly_token_budget != null ? Number(tenant.llm_monthly_token_budget) : null);

  return {
    tenant_id,
    primary,
    fallback,
    provider,
    fallback_provider,
    context_cap: contextCapFor(primary),
    monthly_budget,
    enable_prompt_cache: settings?.enable_prompt_cache ?? true,
  };
}

// Per-flow env overrides. Lets operators route e.g. "summarize" to a cheaper
// model and "generate" to a stronger one without any workflow-level config.
// Variables follow the shape `{FLOW}_LLM_PROVIDER` and `{FLOW}_MODEL` — these
// must be upper-cased flow names. Unknown / unset variables fall through to
// the tenant-resolved route.
function flowEnvKey(flow: LlmFlow): string {
  return flow.toUpperCase();
}

export function applyFlowEnvOverrides(route: ModelRoute, flow: LlmFlow): ModelRoute {
  const key = flowEnvKey(flow);
  const providerEnvVar = `${key}_LLM_PROVIDER`;
  const modelEnvVar = `${key}_MODEL`;
  const providerDetected = detectConfiguredProvider({ providerEnvVar });
  const modelOverride = process.env[modelEnvVar];
  if (providerDetected === "unconfigured" && !modelOverride) return route;
  const nextPrimary = modelOverride ?? route.primary;
  return {
    ...route,
    primary: nextPrimary,
    provider: providerDetected === "unconfigured" ? route.provider : providerDetected,
    context_cap: contextCapFor(nextPrimary),
  };
}

export interface InvokeParams<T = unknown> {
  flow: LlmFlow;
  tenant_id: string;
  user_turns: UserTurn[];
  connector_id?: string;
  workflow_id?: string;
  prior_failures?: Parameters<typeof assembleContext>[0]["prior_failures"];
  user_memory?: string;
  /** When set, run as `generateObject` with submit-tool loop. */
  schema?: ZodType<T>;
  telemetry_metadata?: Record<string, string | number | boolean>;
  /** Optional explicit route; otherwise resolved from tenant settings. */
  route?: ModelRoute;
}

export interface InvokeResult<T = unknown> {
  object?: T;
  text: string;
  model_used: string;
  fell_back: boolean;
  route: ModelRoute;
  assembled: AssembledContext;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
  };
}

function mapProviderError(err: unknown): LlmProviderError {
  const kind = classifyProviderError(err);
  const msg = err instanceof Error ? err.message : String(err);
  const mappedKind =
    kind === "rate_limit"
      ? "rate_limit"
      : kind === "quota_exhausted"
        ? "quota_exhausted"
        : kind === "overloaded"
          ? "overloaded"
          : kind === "context_length_exceeded"
            ? "context_length_exceeded"
            : "other";
  return new LlmProviderError(mappedKind, msg);
}

export async function invoke<T = unknown>(
  params: InvokeParams<T>,
  exec?: Executor,
): Promise<InvokeResult<T>> {
  const db = exec ?? getDb();
  const base_route = params.route ?? (await resolveModelRoute(params.tenant_id, db));
  const route = applyFlowEnvOverrides(base_route, params.flow);
  log.llm.route.resolved({
    model_id: route.primary,
    fallback: route.fallback,
    provider: route.provider,
    tenant_id: params.tenant_id,
    flow: params.flow,
  });

  // 1) Assemble context.
  const assembleParams: Parameters<typeof assembleContext>[0] = {
    tenant_id: params.tenant_id,
    flow: params.flow,
    user_turns: params.user_turns,
    max_tokens: route.context_cap,
    model: route.primary,
  };
  if (params.connector_id) assembleParams.connector_id = params.connector_id;
  if (params.workflow_id) assembleParams.workflow_id = params.workflow_id;
  if (params.prior_failures) assembleParams.prior_failures = params.prior_failures;
  if (params.user_memory !== undefined) assembleParams.user_memory = params.user_memory;
  const assembled = await assembleContext(assembleParams, db);

  // 2) Budget pre-check.
  const estimated = assembled.prompt.token_counts.total + 1024;
  try {
    await checkBudget(params.tenant_id, estimated, route.monthly_budget, db);
    const verdict = await checkAndDecrement(params.tenant_id, estimated, db);
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
          tenant_id: params.tenant_id,
          flow: params.flow,
          model: route.primary,
          prompt_tokens: assembled.prompt.token_counts.total,
          completion_tokens: 0,
          latency_ms: 0,
          result: "quota_exhausted",
          error: "llm_quota_exhausted",
        },
        db,
      );
      recordLlmQuotaExhausted({ tenant_id: params.tenant_id });
    }
    throw err;
  }

  // 3) Dispatch.
  const start = Date.now();
  if (route.provider === "mock") {
    return await dispatchMock<T>(params, route, assembled, start, db);
  }
  return await dispatchReal<T>(params, route, assembled, start, db);
}

async function dispatchMock<T>(
  params: InvokeParams<T>,
  route: ModelRoute,
  assembled: AssembledContext,
  start: number,
  db: Executor,
): Promise<InvokeResult<T>> {
  const mock = getMockProvider();
  // The mock provider reads from `EnhancedPrompt.system` directly, so we
  // flatten stable+volatile back into a single system string for parity
  // with the pre-refactor behaviour.
  const flatSystem = [assembled.blocks.stable, assembled.blocks.volatile]
    .filter((s) => s.length > 0)
    .join("\n\n");
  const mockPrompt = {
    ...assembled.prompt,
    system: flatSystem,
  };

  let fell_back = false;
  let res: MockResult<T>;
  try {
    res = mock.call<T>({
      flow: params.flow,
      model: route.primary,
      prompt: mockPrompt,
      enable_prompt_cache: route.enable_prompt_cache,
    });
  } catch (err) {
    if (!(err instanceof LlmProviderError)) throw err;
    // Record the primary-model error row so observability + test parity
    // with the pre-refactor provider.ts remains intact.
    await recordUsage(
      {
        tenant_id: params.tenant_id,
        flow: params.flow,
        model: route.primary,
        prompt_tokens: assembled.prompt.token_counts.total,
        completion_tokens: 0,
        latency_ms: Date.now() - start,
        result: "error",
        error: err.message,
      },
      db,
    );
    if (
      err.kind === "rate_limit" ||
      err.kind === "overloaded" ||
      err.kind === "context_length_exceeded"
    ) {
      fell_back = true;
      logger.warn({
        module: "llm",
        action: "fallback.triggered",
        msg: "llm fallback engaged",
        flow: params.flow,
        primary: route.primary,
        fallback: route.fallback,
        kind: err.kind,
      });
      res = mock.call<T>({
        flow: params.flow,
        model: route.fallback,
        prompt: mockPrompt,
        enable_prompt_cache: route.enable_prompt_cache,
      });
    } else {
      throw err;
    }
  }
  const latency = Date.now() - start;
  const modelUsed = fell_back ? route.fallback : route.primary;
  await recordUsage(
    {
      tenant_id: params.tenant_id,
      flow: params.flow,
      model: modelUsed,
      prompt_tokens: res.prompt_tokens,
      completion_tokens: res.completion_tokens,
      latency_ms: latency,
      result: "success",
    },
    db,
  );
  recordLlmTokens({
    tenant_id: params.tenant_id,
    model: modelUsed,
    flow: params.flow,
    prompt_tokens: res.prompt_tokens,
    completion_tokens: res.completion_tokens,
  });
  recordLlmCacheUsage({
    tenant_id: params.tenant_id,
    model: modelUsed,
    flow: params.flow,
    prompt_tokens: res.prompt_tokens,
    cache_read_tokens: res.cache_read_tokens ?? 0,
    cache_creation_tokens: res.cache_creation_tokens ?? 0,
  });
  return {
    ...(res.object !== undefined ? { object: res.object } : {}),
    text: res.text,
    model_used: modelUsed,
    fell_back,
    route,
    assembled,
    usage: {
      input_tokens: res.prompt_tokens,
      output_tokens: res.completion_tokens,
      cache_read_tokens: res.cache_read_tokens ?? 0,
      cache_creation_tokens: res.cache_creation_tokens ?? 0,
    },
  };
}

async function dispatchReal<T>(
  params: InvokeParams<T>,
  route: ModelRoute,
  assembled: AssembledContext,
  start: number,
  db: Executor,
): Promise<InvokeResult<T>> {
  const systemMessages = toSystemMessages(assembled.blocks, {
    enabled: route.enable_prompt_cache,
    ttl: "1h",
  });
  const userMessages: SubkitLlmMessage[] = assembled.prompt.messages.map((m) => ({
    role: m.role as "user" | "assistant" | "system" | "tool",
    content: m.content_parts ?? m.content,
  }));

  const messages: SubkitLlmMessage[] = [
    ...systemMessages.map((m) => ({ role: m.role as "system", content: m.content })),
    ...userMessages,
  ];

  const model = new AiSdkModel({
    providerOverride: route.provider,
    defaultModel: route.primary,
    modelOverride: route.primary,
    fallback: {
      providerOverride: route.fallback_provider,
      defaultModel: route.fallback,
      modelOverride: route.fallback,
    },
  });

  const telemetryMeta = {
    tenant_id: params.tenant_id,
    flow: params.flow,
    ...(params.telemetry_metadata ?? {}),
  };

  let text = "";
  let object: T | undefined;
  let usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };
  let fell_back = false;

  try {
    if (params.schema) {
      // Every schema flow runs through the same submit/abort tool loop with
      // `toolChoice: "required"`. The loop is capped at MAX_TOOL_LOOP_ATTEMPTS
      // (see `ai-sdk-model.ts`); callers can tighten it per-flow via an
      // explicit `maxAttempts` on the `schema` path once we expose it on
      // `InvokeParams` (not yet wired — use the default for now).
      const jsonSchema = zodToJson(params.schema);
      const r = await model.generateObject<T>({
        messages,
        schema: jsonSchema,
        temperature: 0,
        metadata: telemetryMeta,
        toolChoice: "required",
      });
      usage = r.usage;
      if (r.success) {
        object = r.response as T;
        text = JSON.stringify(object);
      } else {
        throw new LlmProviderError("other", String(r.response));
      }
    } else {
      const r = await model.generateText(messages, {
        temperature: 0,
        metadata: telemetryMeta,
      });
      usage = r.usage;
      text = r.response;
      // Attempt best-effort JSON extraction for non-converse flows.
      if (params.flow !== "converse") {
        const extracted = extractJson<T>(text);
        if (extracted !== undefined) object = extracted;
      }
    }
  } catch (err) {
    if (isFallbackEligible(err) && !fell_back) {
      fell_back = true;
      logger.warn({
        module: "llm",
        action: "fallback.triggered",
        flow: params.flow,
        primary: route.primary,
        fallback: route.fallback,
        kind: classifyProviderError(err),
      });
      // AiSdkModel already tries its own fallback when configured; if we
      // reach here it means the error wasn't caught or fallback wasn't
      // set. Re-throw with the structured kind.
    }
    const mapped = mapProviderError(err);
    const latency = Date.now() - start;
    await recordUsage(
      {
        tenant_id: params.tenant_id,
        flow: params.flow,
        model: route.primary,
        prompt_tokens: assembled.prompt.token_counts.total,
        completion_tokens: 0,
        latency_ms: latency,
        result: "error",
        error: mapped.message,
      },
      db,
    );
    throw mapped;
  }

  const latency = Date.now() - start;
  const modelUsed = route.primary;

  await account(
    {
      tenant_id: params.tenant_id,
      metadata: telemetryMeta,
      model: modelUsed,
      usage,
      latency_ms: latency,
      result: "success",
      estimated_prompt_tokens: assembled.prompt.token_counts.total,
    },
    db,
  );
  recordLlmTokens({
    tenant_id: params.tenant_id,
    model: modelUsed,
    flow: params.flow,
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
  });
  recordLlmCacheUsage({
    tenant_id: params.tenant_id,
    model: modelUsed,
    flow: params.flow,
    prompt_tokens: usage.input_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_creation_tokens: usage.cache_creation_tokens,
  });
  audit({
    tenant_id: params.tenant_id,
    actor_type: "system",
    action: AuditAction.LLM_INVOCATION,
    resource_type: "llm",
    result: "success",
    metadata: {
      model: modelUsed,
      provider: route.provider,
      flow: params.flow,
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      fell_back,
      latency_ms: latency,
    },
  });

  return {
    ...(object !== undefined ? { object } : {}),
    text,
    model_used: modelUsed,
    fell_back,
    route,
    assembled,
    usage,
  };
}

function extractJson<T>(text: string): T | undefined {
  // 1) raw text via safeParseJson (raw parse → jsonrepair fallback).
  const direct = safeParseJson<T>(text);
  if (direct !== undefined) return direct;

  // 2) fenced ```json ...``` block.
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) {
    const fenced = safeParseJson<T>(fenceMatch[1]);
    if (fenced !== undefined) return fenced;
  }

  // 3) brace / bracket-balanced slice — last resort for prose-wrapped JSON.
  const braceStart = text.indexOf("{");
  const bracketStart = text.indexOf("[");
  const start =
    braceStart >= 0 && (bracketStart < 0 || braceStart < bracketStart) ? braceStart : bracketStart;
  if (start >= 0) {
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    const end = text.lastIndexOf(close);
    if (end > start) {
      const sliced = safeParseJson<T>(text.slice(start, end + 1));
      if (sliced !== undefined) return sliced;
    }
  }
  return undefined;
}
