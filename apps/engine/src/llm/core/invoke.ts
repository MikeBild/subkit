import type { LanguageModel } from "ai";
import { and, eq } from "drizzle-orm";
import type { ZodType } from "zod";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConfig } from "../../config/loader.ts";
import { type Executor, getDb } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
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
  usageAttribution,
} from "../accounting/index.ts";
import { LlmProviderError, LlmQuotaExhausted } from "../errors.ts";
import { getMockProvider, type MockResult } from "../mock-provider.ts";
import { classifyProviderError, shouldFallBack } from "../provider-errors.ts";
import type { LlmFlow, LlmProviderKind, ModelRoute, UserTurn } from "../types.ts";
import { AiSdkModel } from "./ai-sdk-model.ts";
import type { SubkitLlmAnsweredBy, SubkitLlmMessage } from "./base-types.ts";
import { promptCacheSupported, toSystemMessages } from "./cache-blocks.ts";
import { type AssembledContext, assembleContext } from "./context-assembler.ts";
import { maybeWrapForDevtools } from "./devtools-wrap.ts";
import {
  detectConfiguredProvider,
  initializeModel,
  type ModelInitOptions,
  withToolInputExamples,
} from "./model-init.ts";
import { safeParseJson } from "./safe-json.ts";

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
  return await maybeWrapForDevtools(
    withToolInputExamples(resolved.model, resolved.provider, resolved.modelId),
  );
}

function zodToJson(schema: ZodType): Record<string, unknown> {
  return zodToJsonSchema7(schema);
}

export const DEFAULT_PRIMARY_MODEL = "claude-sonnet-4-6";
export const DEFAULT_FALLBACK_MODEL = "claude-opus-4-7";

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
    default_primary: cfg.model || DEFAULT_PRIMARY_MODEL,
    default_fallback: cfg.fallback_model || DEFAULT_FALLBACK_MODEL,
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

  const tenantRows = await db
    .select()
    .from(tenants)
    .where(and(eq(tenants.id, tenant_id)))
    .limit(1);
  const tenant = tenantRows[0];

  let cfgModel: string | undefined;
  let cfgFallback: string | undefined;
  try {
    const cfg = getConfig(tenant_id).llm;
    if (cfg.model) cfgModel = cfg.model;
    if (cfg.fallback_model) cfgFallback = cfg.fallback_model;
  } catch {}
  const primary = tenant?.llm_primary ?? cfgModel ?? DEFAULT_PRIMARY_MODEL;
  const fallback = tenant?.llm_fallback ?? cfgFallback ?? DEFAULT_FALLBACK_MODEL;
  const provider = currentProvider(tenant_id);
  const fallback_provider = currentFallbackProvider(provider, tenant_id);
  const monthly_budget = resolveMonthlyBudget(tenant_id);

  return {
    tenant_id,
    primary,
    fallback,
    provider,
    fallback_provider,
    context_cap: contextCapFor(primary),
    monthly_budget,
  };
}

function flowEnvKey(flow: LlmFlow): string {
  return flow.toUpperCase();
}

const ELEVATED_FLOWS: ReadonlySet<LlmFlow> = new Set(["judge", "generate"]);

export function applyFlowModelElevation(route: ModelRoute, flow: LlmFlow): ModelRoute {
  if (!ELEVATED_FLOWS.has(flow)) return route;
  if (!route.fallback || route.fallback === route.primary) return route;
  return {
    ...route,
    primary: route.fallback,
    provider: route.fallback_provider,
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
  schema?: ZodType<T>;
  telemetry_metadata?: Record<string, string | number | boolean>;
  principal?: ResolvedPrincipal | null;
  route?: ModelRoute;
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
  const assembled = await instrument({
    module: "llm",
    action: "context.assemble",
    memory: true,
    fields: { flow: params.flow },
    fn: () => assembleContext(assembleParams, db),
  });

  const actor = actorFields(params.principal);
  const estimated = assembled.prompt.token_counts.total + 1024;
  try {
    await checkBudget(params.tenant_id, estimated, route.monthly_budget, db);
    const verdict = await checkAndDecrement(
      params.tenant_id,
      estimated,
      db,
      actor.actor_type === "user" ? actor.user_id : null,
    );
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

  const start = Date.now();
  const result =
    route.provider === "mock"
      ? await dispatchMock<T>(params, route, assembled, start, db)
      : await dispatchReal<T>(params, route, assembled, start, db);
  invokeFields.model = result.model_used;
  return result;
}

async function dispatchMock<T>(
  params: InvokeParams<T>,
  route: ModelRoute,
  assembled: AssembledContext,
  start: number,
  db: Executor,
): Promise<InvokeResult<T>> {
  const mock = getMockProvider();
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
    });
  } catch (err) {
    if (!(err instanceof LlmProviderError)) throw err;
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
    if (shouldFallBack(err, route.provider, route.fallback_provider)) {
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
      });
    } else {
      throw err;
    }
  }
  const latency = Date.now() - start;
  const modelUsed = fell_back ? route.fallback : route.primary;
  const providerUsed = fell_back ? route.fallback_provider : route.provider;
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
    provider: providerUsed,
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
  audit(
    {
      tenant_id: params.tenant_id,
      actor_type: "system",
      action: AuditAction.LLM_INVOCATION,
      resource_type: "llm",
      result: "success",
      metadata: {
        model: modelUsed,
        provider: providerUsed,
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
    enabled: promptCacheSupported(route.provider, route.primary),
    ttl: "1h",
  });
  const userMessages: SubkitLlmMessage[] = assembled.prompt.messages.map((m) => ({
    role: m.role as "user" | "assistant" | "system" | "tool",
    content: m.content_parts ?? m.content,
  }));

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
  let answeredBy: SubkitLlmAnsweredBy = { model_used: route.primary, fell_back: false };

  try {
    if (params.schema) {
      const jsonSchema = zodToJson(params.schema);
      const r = await model.generateObject<T>({
        messages,
        schema: jsonSchema,
        temperature: 0,
        metadata: telemetryMeta,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      usage = r.usage;
      answeredBy = r;
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
      answeredBy = r;
      text = r.response;
      if (params.flow !== "converse") {
        const extracted = extractJson<T>(text);
        if (extracted !== undefined) object = extracted;
      }
    }
  } catch (err) {
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
        ...usageAttribution(telemetryMeta),
      },
      db,
    );
    throw mapped;
  }

  const latency = Date.now() - start;
  const modelUsed = answeredBy.model_used;
  const fell_back = answeredBy.fell_back;
  const providerUsed = fell_back ? route.fallback_provider : route.provider;

  if (fell_back) {
    await recordUsage(
      {
        tenant_id: params.tenant_id,
        flow: params.flow,
        model: route.primary,
        prompt_tokens: assembled.prompt.token_counts.total,
        completion_tokens: 0,
        latency_ms: 0,
        result: "error",
        error: answeredBy.primary_error ?? "primary refused; answered by the fallback",
        ...actorFields(params.principal),
        ...usageAttribution(telemetryMeta),
      },
      db,
    );
  }

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
    provider: providerUsed,
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
  audit(
    {
      tenant_id: params.tenant_id,
      actor_type: "system",
      action: AuditAction.LLM_INVOCATION,
      resource_type: "llm",
      result: "success",
      metadata: {
        model: modelUsed,
        provider: providerUsed,
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
  const direct = safeParseJson<T>(text);
  if (direct !== undefined) return direct;

  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) {
    const fenced = safeParseJson<T>(fenceMatch[1]);
    if (fenced !== undefined) return fenced;
  }

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
