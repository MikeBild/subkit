// `invoke` — single entry point for every LLM call in the engine.
//
// Responsibilities (in order):
//   1) Resolve per-tenant model route (primary/fallback, provider, budget,
//      cache-toggle) from `tenant_llm_settings` + env fallback.
//   2) Budget pre-check and decrement via `llm/budgets.ts`.
//   3) Assemble context via `core/context-assembler.ts` → stable/volatile
//      cache blocks + a budget report.
//   4) Dispatch:
//        provider === "mock" → in-process mock provider (tests)
//        otherwise            → AiSdkModel (gateway-first, via `ai`)
//   5) Post-hoc reconcile SDK-reported usage into `llm_usage` via
//      `core/token-accountant.ts`.
//   6) Return a uniform `{result, prompt, blocks, budget_report,
//      model_used, fell_back}` envelope.
//
// This file is the only place the engine touches either the AiSdkModel
// or the mock provider directly. All four flows (generate, extract,
// repair, converse) are thin wrappers around `invoke`.

import type { LanguageModel } from "ai";
import { and, eq } from "drizzle-orm";
import { type ZodType, z } from "zod";
import { type Db, getDb } from "../../db/client.ts";
import { tenantLlmSettings, tenants } from "../../db/schema/index.ts";
import { env } from "../../env.ts";
import { logger } from "../../logging/logger.ts";
import { recordLlmQuotaExhausted, recordLlmTokens } from "../../observability/instrumentation.ts";
import { checkAndDecrement, checkBudget, recordUsage } from "../budgets.ts";
import { LlmProviderError, LlmQuotaExhausted } from "../errors.ts";
import { getMockProvider, type MockResult } from "../mock-provider.ts";
import { contextCapFor } from "../tokens.ts";
import type { LlmFlow, LlmProviderKind, ModelRoute, UserTurn } from "../types.ts";
import { AiSdkModel, classifyProviderError, isFallbackEligible } from "./ai-sdk-model.ts";
import type { SubkitLlmMessage } from "./base-types.ts";
import { toSystemMessages } from "./cache-blocks.ts";
import { type AssembledContext, assembleContext } from "./context-assembler.ts";
import { initializeModel } from "./model-init.ts";
import { account } from "./token-accountant.ts";

/**
 * Resolve a raw SDK LanguageModel for the given provider+model id. Used
 * by `conversations/loop.ts` which drives `streamText` directly.
 * Prefers the gateway when configured; otherwise loads the provider-specific
 * package via dynamic import.
 */
export async function resolveLanguageModel(
  provider: LlmProviderKind,
  modelId: string,
): Promise<LanguageModel | string> {
  if (provider === "mock") {
    // Callers short-circuit mock routes before reaching this function.
    throw new Error(
      "resolveLanguageModel does not handle mock; callers must check route.provider first",
    );
  }
  const bare = modelId.startsWith("anthropic:") ? modelId.slice("anthropic:".length) : modelId;
  // Pass `providerOverride` so `initializeModel` does not silently fall
  // back to mock when `LLM_PROVIDER` is unset even though the route
  // already decided on a real provider (e.g. inferred from the presence
  // of ANTHROPIC_API_KEY). Without this, every production conversation
  // with `LLM_PROVIDER` unset gets a `mock:never-dispatched` sentinel
  // dispatched to streamText, which throws and surfaces as
  // `internal_error` to the operator.
  const resolved = await initializeModel({ providerOverride: provider, defaultModel: bare });
  return resolved.model;
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
  inferred_provider: LlmProviderKind;
  anthropic_key_set: boolean;
  gateway_key_set: boolean;
  default_primary: string;
  default_fallback: string;
}

export function globalLlmStatus(): GlobalLlmStatus {
  return {
    provider_env: process.env.LLM_PROVIDER ?? null,
    inferred_provider: currentProvider(),
    anthropic_key_set: Boolean(env.ANTHROPIC_API_KEY),
    gateway_key_set: Boolean(process.env.AI_GATEWAY_API_KEY),
    default_primary: env.LLM_PRIMARY ?? DEFAULT_PRIMARY,
    default_fallback: env.LLM_FALLBACK ?? DEFAULT_FALLBACK,
  };
}

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
    return raw as LlmProviderKind;
  }
  // Default: gateway when AI_GATEWAY_API_KEY is set, else mock (test-friendly).
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.AI_GATEWAY_API_KEY) return "anthropic"; // gateway proxies
  return "mock";
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
  const route = params.route ?? (await resolveModelRoute(params.tenant_id, db));

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
    res = mock.call<T>({ flow: params.flow, model: route.primary, prompt: mockPrompt });
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
      res = mock.call<T>({ flow: params.flow, model: route.fallback, prompt: mockPrompt });
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
    content: m.content,
  }));

  const messages: SubkitLlmMessage[] = [
    ...systemMessages.map((m) => ({ role: m.role as "system", content: m.content })),
    ...userMessages,
  ];

  const model = new AiSdkModel({
    defaultModel: route.primary,
    fallback: { defaultModel: route.fallback },
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
      const jsonSchema = zodToJson(params.schema);
      const r = await model.generateObject<T>({
        messages,
        schema: jsonSchema,
        temperature: 0,
        metadata: telemetryMeta,
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
  try {
    return JSON.parse(text) as T;
  } catch {
    // Fall through.
  }
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1]) as T;
    } catch {
      // Fall through.
    }
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
      try {
        return JSON.parse(text.slice(start, end + 1)) as T;
      } catch {
        // Give up.
      }
    }
  }
  return undefined;
}
