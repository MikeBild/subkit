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
import type { ZodType } from "zod";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConfig } from "../../config/loader.ts";
import { type Executor, getDb } from "../../db/client.ts";
import { tenantLlmSettings, tenants } from "../../db/schema/index.ts";
import { log, logger } from "../../logging/logger.ts";
import { zodToJsonSchema7 } from "../../mcp/json-schema.ts";
import {
  recordLlmCacheUsage,
  recordLlmCallDuration,
  recordLlmQuotaExhausted,
  recordLlmTokens,
} from "../../observability/instrumentation.ts";
import { instrument } from "../../observability/runtime-telemetry.ts";
import {
  account,
  actorFields,
  checkAndDecrement,
  checkBudget,
  contextCapFor,
  recordUsage,
  resolveMonthlyBudget,
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
import { detectConfiguredProvider, initializeModel, type ModelInitOptions } from "./model-init.ts";
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
  tenantId?: string,
): Promise<LanguageModel | string> {
  const bare = modelId.includes(":") ? modelId.slice(modelId.indexOf(":") + 1) : modelId;
  const initOptions: ModelInitOptions = {
    providerOverride: provider,
    defaultModel: bare,
    modelOverride: bare,
    ...(tenantId ? { tenantId } : {}),
  };
  const resolved = await initializeModel(initOptions);
  return await maybeWrapForDevtools(resolved.model);
}

function zodToJson(schema: ZodType): Record<string, unknown> {
  // Shared boundary helper: draft-7 with deterministic object shapes
  // (`required: [...]` arrays, no `anyOf` unions for optional fields).
  return zodToJsonSchema7(schema);
}

const DEFAULT_PRIMARY = "claude-sonnet-4-6";
// The fallback carries TWO jobs, and they pull in the same direction only if it
// is the STRONGER model: it absorbs an overloaded primary, and it is where
// `applyFlowModelElevation` sends `judge` and `generate`. It must also be
// authoring-capable on its own — a converse turn that dropped to it still has
// to write correct code — which rules out Haiku.
//
// This used to be `claude-sonnet-4-5`, one step BELOW the primary, which
// inverted the elevation: on a default-configured engine the two
// quality-critical flows were quietly DOWNGRADED, the opposite of what the
// elevation exists to do. The nightly judge-calibration job is what surfaced
// it — it pins no model, so it rode the shipped default and failed while its
// sibling job, which pins `claude-sonnet-4-6`, passed on the same key.
const DEFAULT_FALLBACK = "claude-opus-4-7";

/**
 * Snapshot of the global LLM-routing configuration for /health.
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

function currentProvider(tenantId?: string): LlmProviderKind {
  const detected = detectConfiguredProvider(tenantId ? { tenantId } : {});
  return detected === "unconfigured" ? "gateway" : detected;
}

function currentFallbackProvider(
  primaryProvider: LlmProviderKind,
  tenantId?: string,
): LlmProviderKind {
  const detected = detectConfiguredProvider({
    providerEnvVar: "LLM_FALLBACK_PROVIDER",
    ...(tenantId ? { tenantId } : {}),
  });
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
    const cfg = getConfig(tenant_id).llm;
    if (cfg.model) cfgModel = cfg.model;
    if (cfg.fallback_model) cfgFallback = cfg.fallback_model;
  } catch {
    /* loader not initialised — unit tests fall back to DEFAULT_* */
  }
  const primary = settings?.llm_primary_model ?? tenant?.llm_primary ?? cfgModel ?? DEFAULT_PRIMARY;
  const fallback =
    settings?.llm_fallback_model ?? tenant?.llm_fallback ?? cfgFallback ?? DEFAULT_FALLBACK;
  const provider =
    (settings?.llm_provider as LlmProviderKind | undefined) ?? currentProvider(tenant_id);
  const fallback_provider = currentFallbackProvider(provider, tenant_id);
  // Asked of the one function that owns this answer, rather than rebuilt from
  // the two columns this used to chain. Those columns had no writer, so the
  // chain could only ever produce `null` while the cap an operator had
  // actually typed — the `tokens.monthly_budget` config leaf — was read by
  // nobody. A second derivation of the same cap is how they drifted apart in
  // the first place.
  const monthly_budget = resolveMonthlyBudget(tenant_id);

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

// Code-level model elevation for quality-critical, LOW-frequency flows.
//
// `judge` (post-preview verdicts that gate auto-commit) and `generate`
// (whole-workflow authoring) each fire roughly once per authoring cycle
// but decide artifact quality outright, while the chat-frequency flows
// (converse / extract / summarize / …) dominate token volume. By
// convention the tenant route's FALLBACK model is the STRONGER one
// (prod: primary Haiku 4.5, fallback Sonnet 4.6 — the primary is picked
// for cost, the fallback for capability), so these two flows are routed
// to the fallback model in code. No env vars: this is shipped behavior,
// not a toggle. When the route carries no distinct fallback the primary
// is kept unchanged. `applyFlowEnvOverrides` still applies ON TOP, so a
// per-flow `{FLOW}_MODEL` operator override wins exactly as before.
const ELEVATED_FLOWS: ReadonlySet<LlmFlow> = new Set(["judge", "generate"]);

export function applyFlowModelElevation(route: ModelRoute, flow: LlmFlow): ModelRoute {
  if (!ELEVATED_FLOWS.has(flow)) return route;
  if (!route.fallback || route.fallback === route.primary) return route;
  return {
    ...route,
    primary: route.fallback,
    provider: route.fallback_provider,
    // The original primary becomes the FALLBACK: an overloaded strong
    // model degrades to the cheaper model instead of retrying itself —
    // without this swap, elevation collapsed primary === fallback and
    // judge/generate failed harder than converse on exactly the
    // overload path.
    fallback: route.primary,
    fallback_provider: route.provider,
    context_cap: contextCapFor(route.fallback),
  };
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
  /**
   * Optional acting principal. The converse flow attributes usage to the
   * end-user via this field; authoring/system flows (generate/extract/
   * repair/…) leave it unset → the row is recorded as `system`.
   */
  principal?: ResolvedPrincipal | null;
  /** Optional explicit route; otherwise resolved from tenant settings. */
  route?: ModelRoute;
  /**
   * Optional caller abort signal. Threaded down to the provider round-trip in
   * `AiSdkModel`, where it is merged with a per-call hard timeout. Nested
   * `invoke()`s inside a tool execution pass the turn/pipeline signal here so a
   * wedged provider connection can't outlive the turn (the STALL fix). When
   * omitted, the per-call timeout still bounds the call.
   */
  signal?: AbortSignal;
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
  // `model` is filled in once the route resolves, so the completion/failure
  // line carries the effective model even though it isn't known at entry.
  const invokeFields: Record<string, unknown> = { flow: params.flow, model: null };
  return instrument({
    module: "llm",
    action: "invoke",
    fields: invokeFields,
    fn: () => invokeInner<T>(params, exec, invokeFields),
  });
}

async function invokeInner<T = unknown>(
  params: InvokeParams<T>,
  exec: Executor | undefined,
  invokeFields: Record<string, unknown>,
): Promise<InvokeResult<T>> {
  const db = exec ?? getDb();
  const base_route = params.route ?? (await resolveModelRoute(params.tenant_id, db));
  // Order matters: code-level elevation first (judge/generate → the
  // stronger fallback model), then env overrides so an operator's
  // per-flow override still has the last word.
  const route = applyFlowEnvOverrides(
    applyFlowModelElevation(base_route, params.flow),
    params.flow,
  );
  invokeFields.model = route.primary;
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
  // Memory-delta wrap around the top-level assembly — this is the known
  // multi-GB per-turn transient (buildModelMessages / prompt construction).
  // Single rss-delta bracket here rather than nested wraps inside the
  // assembler keeps the signal attributable without double-counting.
  const assembled = await instrument({
    module: "llm",
    action: "context.assemble",
    memory: true,
    fields: { flow: params.flow },
    fn: () => assembleContext(assembleParams, db),
  });

  // 2) Budget pre-check. The user cap (when the actor is a user with a
  // per-user budget) is an additional ceiling on top of the tenant cap.
  const actor = actorFields(params.principal);
  const estimated = assembled.prompt.token_counts.total + 1024;
  try {
    await checkBudget(params.tenant_id, estimated, route.monthly_budget, db);
    const verdict = await checkAndDecrement(params.tenant_id, estimated, db, actor.user_id);
    if (!verdict.ok) {
      throw new LlmQuotaExhausted("llm_quota_exhausted", {
        used: verdict.used,
        projected_tokens: verdict.projected_tokens,
        budget: verdict.budget,
        remaining: verdict.remaining,
        scope: verdict.scope ?? "tenant",
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
          ...actor,
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
        ...actorFields(params.principal),
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
      ...actorFields(params.principal),
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
  recordLlmCallDuration({
    provider: route.provider,
    model: modelUsed,
    flow: params.flow,
    duration_ms: latency,
  });
  recordLlmCacheUsage({
    tenant_id: params.tenant_id,
    model: modelUsed,
    flow: params.flow,
    prompt_tokens: res.prompt_tokens,
    cache_read_tokens: res.cache_read_tokens ?? 0,
    cache_creation_tokens: res.cache_creation_tokens ?? 0,
  });
  // Mock + real dispatch parity: emit the same `LLM_INVOCATION` audit
  // row dispatchReal writes (below) so integration tests running against
  // the mock can still assert the audit trail. Without this, a future
  // refactor that drops the audit write inside `invoke()` would only
  // fail in production, not in CI. The optional executor routes the
  // insert to the test DB so disposable-DB tests see it.
  audit(
    {
      tenant_id: params.tenant_id,
      actor_type: "system",
      action: AuditAction.LLM_INVOCATION,
      resource_type: "llm",
      result: "success",
      metadata: {
        model: modelUsed,
        provider: route.provider,
        flow: params.flow,
        prompt_tokens: res.prompt_tokens,
        completion_tokens: res.completion_tokens,
        cache_read_tokens: res.cache_read_tokens ?? 0,
        fell_back,
        latency_ms: latency,
      },
    },
    db,
  );
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

  // Spread rather than re-shape: the previous `.map` rebuilt each message from
  // role and content alone, which silently discarded the cache hint that the
  // line above had just attached.
  const messages: SubkitLlmMessage[] = [...systemMessages, ...userMessages];

  const model = new AiSdkModel({
    tenantId: params.tenant_id,
    providerOverride: route.provider,
    defaultModel: route.primary,
    modelOverride: route.primary,
    fallback: {
      tenantId: params.tenant_id,
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
        ...(params.signal ? { signal: params.signal } : {}),
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
        ...(params.signal ? { signal: params.signal } : {}),
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
        ...actorFields(params.principal),
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
      ...actorFields(params.principal),
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
  recordLlmCallDuration({
    provider: route.provider,
    model: modelUsed,
    flow: params.flow,
    duration_ms: latency,
  });
  recordLlmCacheUsage({
    tenant_id: params.tenant_id,
    model: modelUsed,
    flow: params.flow,
    prompt_tokens: usage.input_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_creation_tokens: usage.cache_creation_tokens,
  });
  // Pass `db` so the row participates in the caller-provided executor
  // (test DBs, in-flight transactions). Matches the mock dispatch.
  audit(
    {
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
    },
    db,
  );

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
