import {
  generateText,
  jsonSchema,
  type ModelMessage,
  NoSuchToolError,
  type Schema,
  type Tool,
  tool,
} from "ai";
import { logger } from "../../logging/logger.ts";
import { recordLlmFallbackInvocation } from "../../observability/instrumentation.ts";
import { instrument } from "../../observability/runtime-telemetry.ts";
import { isTracingActive } from "../../observability/tracing.ts";
import { classifyProviderError, shouldFallBack } from "../provider-errors.ts";
import type {
  SubkitLlm,
  SubkitLlmAnsweredBy,
  SubkitLlmMessage,
  SubkitLlmObjectGeneratorInput,
  SubkitLlmObjectResponse,
  SubkitLlmResponse,
  SubkitLlmTelemetryMetadata,
  SubkitLlmToolDefinition,
  SubkitLlmToolWithContext,
} from "./base-types.ts";
import { maybeWrapForDevtools } from "./devtools-wrap.ts";
import {
  initializeModel,
  type ModelInitOptions,
  ProviderMisconfiguredError,
  type ResolvedModel,
} from "./model-init.ts";
import { normalizeSchema, unwrapResult } from "./schema-normalizer.ts";

export const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

export const LLM_CALL_TIMEOUT_MS = 90_000;

export const MAX_TOOL_LOOP_ATTEMPTS = 8;
const MODEL_CONTEXT_LENGTHS: Record<string, number> = {
  "claude-sonnet-4-5": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-opus-4-7": 200_000,
  "claude-opus-4-8": 200_000,
  "gpt-4o": 128_000,
  "gpt-4.1": 1_047_000,
  "o1-preview": 200_000,
  "o1-mini": 128_000,
};

export function knownContextModelIds(): string[] {
  return Object.keys(MODEL_CONTEXT_LENGTHS);
}

function contextLengthFor(modelId: string): number {
  const bare = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
  return MODEL_CONTEXT_LENGTHS[bare] ?? 128_000;
}

const DATE_PREFIX = "The current date and time is";

function withCurrentDate(messages: SubkitLlmMessage[]): SubkitLlmMessage[] {
  const already = messages.some(
    (m) => typeof m.content === "string" && m.content.startsWith(DATE_PREFIX),
  );
  if (already) return messages;
  let at = 0;
  while (at < messages.length && messages[at]?.role === "system") at += 1;
  const stamp: SubkitLlmMessage = {
    role: "system",
    content: `${DATE_PREFIX} ${new Date().toISOString()}`,
  };
  return [...messages.slice(0, at), stamp, ...messages.slice(at)];
}

export interface AiSdkModelOptions extends ModelInitOptions {
  fallback?: ModelInitOptions;
  maxRetries?: number;
  callTimeoutMs?: number;
  generateTextFn?: typeof generateText;
}

export class LlmCallAbortedError extends Error {
  constructor(timeoutMs: number, callerAborted: boolean) {
    super(
      callerAborted
        ? "llm call aborted (caller signal)"
        : `llm call aborted (timeout ${Math.round(timeoutMs / 1000)}s or caller signal)`,
    );
    this.name = "LlmCallAbortedError";
  }
}

function buildCallSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): { signal: AbortSignal; isCallerAborted: () => boolean } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  return { signal, isCallerAborted: () => callerSignal?.aborted ?? false };
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

export class AiSdkModel implements SubkitLlm {
  public contextLength: number;
  public modelId: string;
  private resolved: ResolvedModel | null = null;
  private fallbackResolved: ResolvedModel | null = null;
  private readonly opts: AiSdkModelOptions;
  private readonly gt: typeof generateText;
  private initPromise: Promise<void> | null = null;

  constructor(modelIdOrOptions?: string | AiSdkModelOptions) {
    if (typeof modelIdOrOptions === "string") {
      this.opts = { defaultModel: modelIdOrOptions };
    } else {
      this.opts = modelIdOrOptions ?? {};
    }
    this.modelId = this.opts.defaultModel ?? DEFAULT_MODEL_ID;
    this.contextLength = contextLengthFor(this.modelId);
    this.gt = this.opts.generateTextFn ?? generateText;
  }

  private async ensureInit(): Promise<ResolvedModel> {
    if (this.resolved) return this.resolved;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const initial = await initializeModel(this.opts);
        this.resolved = { ...initial, model: await maybeWrapForDevtools(initial.model) };
        this.modelId = this.resolved.modelId;
        this.contextLength = contextLengthFor(this.modelId);
        if (this.opts.fallback) {
          try {
            const fb = await initializeModel(this.opts.fallback);
            this.fallbackResolved = { ...fb, model: await maybeWrapForDevtools(fb.model) };
          } catch (err) {
            logger.warn({
              module: "llm",
              action: "fallback.init_failed",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      })();
    }
    await this.initPromise;
    if (!this.resolved)
      throw new Error("ai-sdk-model: ensureInit returned without a resolved model");
    return this.resolved;
  }

  private buildTools(
    submitSchema: Schema<unknown>,
    extras: SubkitLlmToolWithContext[] | undefined,
    usageCounts: Map<string, number>,
  ): Record<string, Tool> {
    const tools: Record<string, Tool> = {
      submit: tool({
        description:
          "Submit the final result in the required format. Submit even on error. Keep non-tool messages brief.",
        inputSchema: submitSchema,
      }),
      abort: tool({
        description: "There is no way given the input to complete the request successfully; abort.",
        inputSchema: jsonSchema({
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
          additionalProperties: false,
        }),
      }),
    };

    if (!extras) return tools;
    for (const item of extras) {
      const def = item.toolDefinition;
      if (!("name" in (def as Record<string, unknown>))) {
        Object.assign(tools, def as Record<string, Tool>);
        continue;
      }
      const td = def as SubkitLlmToolDefinition;
      const uses = usageCounts.get(td.name) ?? 0;
      if (item.maxUses !== undefined && uses >= item.maxUses) continue;
      const baseSpec = {
        description: td.description,
        inputSchema: jsonSchema(td.arguments as Parameters<typeof jsonSchema>[0]),
      };
      tools[td.name] = td.execute
        ? tool({
            ...baseSpec,
            execute: async (args: unknown) => td.execute!(args, item.toolContext),
          })
        : tool(baseSpec);
    }
    return tools;
  }

  private async callWithFallback(params: {
    messages: SubkitLlmMessage[];
    temperature?: number;
    tools?: Record<string, Tool>;
    toolChoice?: "auto" | "required" | "none" | { type: "tool"; toolName: string };
    metadata?: SubkitLlmTelemetryMetadata;
    signal?: AbortSignal;
    maxOutputTokens?: number;
  }): Promise<SubkitLlmAnsweredBy & { result: Awaited<ReturnType<typeof generateText>> }> {
    const primary = await this.ensureInit();
    const timeoutMs = this.opts.callTimeoutMs ?? LLM_CALL_TIMEOUT_MS;
    const { signal: callSignal, isCallerAborted } = buildCallSignal(timeoutMs, params.signal);
    const callOpts: Parameters<typeof generateText>[0] = {
      model: primary.model,
      messages: params.messages as ModelMessage[],
      maxRetries: this.opts.maxRetries ?? 0,
      abortSignal: callSignal,
      allowSystemInMessages: true,
    };
    if (params.temperature !== undefined) callOpts.temperature = params.temperature;
    if (params.tools) callOpts.tools = params.tools;
    if (params.toolChoice) callOpts.toolChoice = params.toolChoice;
    if (params.maxOutputTokens !== undefined) callOpts.maxOutputTokens = params.maxOutputTokens;
    if (params.metadata) {
      const rc = params.metadata as Record<string, string | number | boolean>;
      callOpts.runtimeContext = rc;
      callOpts.telemetry = {
        isEnabled: true,
        recordInputs: isTracingActive(),
        recordOutputs: isTracingActive(),
        functionId: String(params.metadata.flow ?? "unknown"),
        includeRuntimeContext: Object.fromEntries(Object.keys(rc).map((k) => [k, true])),
      };
    }
    try {
      const result = await instrument({
        module: "llm",
        action: "model.call",
        fields: { model: primary.modelId },
        fn: () => this.gt(callOpts),
      });
      return { result, model_used: primary.modelId, fell_back: false };
    } catch (err) {
      if (isAbortError(err)) throw new LlmCallAbortedError(timeoutMs, isCallerAborted());
      if (
        !this.fallbackResolved ||
        !shouldFallBack(err, primary.provider, this.fallbackResolved.provider)
      ) {
        throw err;
      }
      const kind = classifyProviderError(err);
      recordLlmFallbackInvocation({
        from: primary.modelId,
        to: this.fallbackResolved.modelId,
        reason: kind,
      });
      logger.warn({
        module: "llm",
        action: "fallback.triggered",
        kind,
        primary: primary.modelId,
        fallback: this.fallbackResolved.modelId,
      });
      const fbOpts: Parameters<typeof generateText>[0] = {
        ...callOpts,
        model: this.fallbackResolved.model,
      };
      const fallbackModelId = this.fallbackResolved.modelId;
      try {
        const result = await instrument({
          module: "llm",
          action: "model.call",
          fields: { model: fallbackModelId },
          fn: () => this.gt(fbOpts),
        });
        return {
          result,
          model_used: fallbackModelId,
          fell_back: true,
          primary_error: err instanceof Error ? err.message : String(err),
        };
      } catch (fbErr) {
        if (isAbortError(fbErr)) throw new LlmCallAbortedError(timeoutMs, isCallerAborted());
        throw fbErr;
      }
    }
  }

  async generateText(
    messages: SubkitLlmMessage[],
    opts?: {
      temperature?: number;
      metadata?: SubkitLlmTelemetryMetadata;
      signal?: AbortSignal;
      maxOutputTokens?: number;
    },
  ): Promise<SubkitLlmResponse> {
    const prepared = withCurrentDate(messages);
    const params: Parameters<typeof this.callWithFallback>[0] = {
      messages: prepared,
      temperature: opts?.temperature ?? 0,
    };
    if (opts?.metadata) params.metadata = opts.metadata;
    if (opts?.signal) params.signal = opts.signal;
    if (opts?.maxOutputTokens !== undefined) params.maxOutputTokens = opts.maxOutputTokens;
    const { result, ...answeredBy } = await this.callWithFallback(params);
    const newMessages = [
      ...prepared,
      ...((result.response.messages as unknown as SubkitLlmMessage[]) ?? []),
    ];
    return {
      ...answeredBy,
      response: result.text,
      messages: newMessages,
      finish_reason: (result.finishReason ?? "stop") as SubkitLlmResponse["finish_reason"],
      usage: {
        input_tokens: Number(result.usage?.inputTokens ?? 0),
        output_tokens: Number(result.usage?.outputTokens ?? 0),
        cache_read_tokens: extractCacheRead(result.providerMetadata),
        cache_creation_tokens: extractCacheCreation(result.providerMetadata),
      },
    };
  }

  async generateObject<T>(
    input: SubkitLlmObjectGeneratorInput & { metadata?: SubkitLlmTelemetryMetadata },
  ): Promise<SubkitLlmObjectResponse<T>> {
    const { schema: cleanedSchema, wrappedInResult } = normalizeSchema(input.schema);
    const schemaObj = jsonSchema(cleanedSchema as Parameters<typeof jsonSchema>[0]);
    const usageCounts = new Map<string, number>();

    const isOModel = this.modelId.startsWith("o");
    const temperature = isOModel ? undefined : (input.temperature ?? 0);

    const seeded = withCurrentDate(input.messages);
    const convo: SubkitLlmMessage[] = [...seeded];

    let finalResult: T | undefined;
    let abortReason: string | undefined;
    let aggregatedUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    };

    let answeredBy: SubkitLlmAnsweredBy = { model_used: this.modelId, fell_back: false };
    const maxAttempts = input.maxAttempts ?? MAX_TOOL_LOOP_ATTEMPTS;
    let attempts = 0;
    while (finalResult === undefined && abortReason === undefined) {
      if (attempts >= maxAttempts) {
        return {
          success: false,
          response: `max_attempts_exceeded after ${attempts} tool-loop iterations`,
          messages: convo,
          usage: aggregatedUsage,
          ...answeredBy,
        };
      }
      attempts += 1;
      const tools = this.buildTools(schemaObj, input.tools, usageCounts);
      const cwfParams: Parameters<typeof this.callWithFallback>[0] = {
        messages: convo,
        tools,
        toolChoice: input.toolChoice ?? "required",
      };
      if (temperature !== undefined) cwfParams.temperature = temperature;
      if (input.metadata) cwfParams.metadata = input.metadata;
      if (input.signal) cwfParams.signal = input.signal;
      const { result, ...answered } = await this.callWithFallback(cwfParams);
      const primaryError = answeredBy.primary_error ?? answered.primary_error;
      answeredBy = {
        model_used: answered.model_used,
        fell_back: answeredBy.fell_back || answered.fell_back,
        ...(primaryError !== undefined ? { primary_error: primaryError } : {}),
      };

      aggregatedUsage = {
        input_tokens: aggregatedUsage.input_tokens + Number(result.usage?.inputTokens ?? 0),
        output_tokens: aggregatedUsage.output_tokens + Number(result.usage?.outputTokens ?? 0),
        cache_read_tokens:
          aggregatedUsage.cache_read_tokens + extractCacheRead(result.providerMetadata),
        cache_creation_tokens:
          aggregatedUsage.cache_creation_tokens + extractCacheCreation(result.providerMetadata),
      };

      if (
        result.finishReason === "error" ||
        result.finishReason === "content-filter" ||
        result.finishReason === "other"
      ) {
        return {
          success: false,
          response: `LLM finished abnormally: ${result.finishReason}`,
          messages: convo,
          usage: aggregatedUsage,
          ...answeredBy,
        };
      }

      const toolCalls = result.toolCalls ?? [];
      for (const call of toolCalls) {
        usageCounts.set(call.toolName, (usageCounts.get(call.toolName) ?? 0) + 1);
        if (call.toolName === "submit") {
          finalResult = unwrapResult<T>((call.input as T) ?? ({} as T), wrappedInResult);
          break;
        }
        if (call.toolName === "abort") {
          abortReason = ((call.input as { reason?: string })?.reason ?? "abort").toString();
          break;
        }
      }

      convo.push(...((result.response.messages as unknown as SubkitLlmMessage[]) ?? []));

      if (finalResult !== undefined || abortReason !== undefined) break;

      if (toolCalls.length === 0) {
        return {
          success: false,
          response: "no tool calls produced by model",
          messages: convo,
          usage: aggregatedUsage,
          ...answeredBy,
        };
      }
    }

    if (abortReason !== undefined) {
      return {
        success: false,
        response: abortReason,
        messages: convo,
        usage: aggregatedUsage,
        ...answeredBy,
      };
    }

    return {
      success: true,
      response: finalResult as T,
      messages: convo,
      usage: aggregatedUsage,
      ...answeredBy,
    };
  }
}

export function extractCacheRead(meta: unknown): number {
  if (!meta || typeof meta !== "object") return 0;
  const m = meta as Record<string, Record<string, unknown>>;
  const anthUsage = m.anthropic?.usage as { cache_read_input_tokens?: number } | undefined;
  if (anthUsage?.cache_read_input_tokens) return Number(anthUsage.cache_read_input_tokens);
  const gwUsage = m.gateway?.usage as { cache_read_input_tokens?: number } | undefined;
  return Number(gwUsage?.cache_read_input_tokens ?? 0);
}

export function extractCacheCreation(meta: unknown): number {
  if (!meta || typeof meta !== "object") return 0;
  const m = meta as Record<string, Record<string, unknown>>;
  const anthUsage = m.anthropic?.usage as { cache_creation_input_tokens?: number } | undefined;
  const anthTop = m.anthropic?.cacheCreationInputTokens as number | undefined;
  if (anthUsage?.cache_creation_input_tokens) {
    return Number(anthUsage.cache_creation_input_tokens);
  }
  if (anthTop) return Number(anthTop);
  const gwUsage = m.gateway?.usage as { cache_creation_input_tokens?: number } | undefined;
  return Number(gwUsage?.cache_creation_input_tokens ?? 0);
}

export { NoSuchToolError, ProviderMisconfiguredError };
