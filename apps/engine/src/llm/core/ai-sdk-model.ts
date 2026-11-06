import {
  generateText,
  jsonSchema,
  type ModelMessage,
  NoObjectGeneratedError,
  NoSuchToolError,
  Output,
  stepCountIs,
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
  SubkitLlmUsage,
} from "./base-types.ts";
import { maybeWrapForDevtools } from "./devtools-wrap.ts";
import {
  GENERATION_ABORT_INPUT_SCHEMA,
  type GenerationAbort,
  parseGenerationAbort,
} from "./generation-abort.ts";
import {
  detectConfiguredProvider,
  initializeModel,
  type ModelInitOptions,
  ProviderMisconfiguredError,
  providerDefaultModel,
  type ResolvedModel,
} from "./model-init.ts";
import { normalizeSchema, unwrapResult } from "./schema-normalizer.ts";
import { compatibleToolPalette } from "./tool-schema-compatibility.ts";

export const LLM_CALL_TIMEOUT_MS = 90_000;

const MAX_TOOL_LOOP_ATTEMPTS = 8;
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

export function isReasoningModel(modelId: string): boolean {
  const bare = modelId.trim().split(/[:/]/).pop() ?? modelId;
  return /^(o\d|gpt-5)/i.test(bare);
}

function contextLengthFor(modelId: string): number {
  const bare = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
  return MODEL_CONTEXT_LENGTHS[bare] ?? 128_000;
}

function initialModelId(opts: ModelInitOptions): string {
  const provider = detectConfiguredProvider({
    ...(opts.providerEnvVar ? { providerEnvVar: opts.providerEnvVar } : {}),
    ...(opts.providerOverride ? { providerOverride: opts.providerOverride } : {}),
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
  });
  return providerDefaultModel(provider, "primary", opts.tenantId) ?? "";
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

interface AiSdkModelOptions extends ModelInitOptions {
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

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

type GenerateTextOptions = Parameters<typeof generateText>[0];
type GenerateTextOutcome = Awaited<ReturnType<typeof generateText>>;

export interface AiSdkUsage {
  inputTokens?: unknown;
  outputTokens?: unknown;
  inputTokenDetails?: { cacheReadTokens?: unknown; cacheWriteTokens?: unknown } | undefined;
}

function tokenCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function usageOf(usage: AiSdkUsage | undefined, providerMetadata: unknown): SubkitLlmUsage {
  const cacheRead = tokenCount(usage?.inputTokenDetails?.cacheReadTokens);
  const cacheWrite = tokenCount(usage?.inputTokenDetails?.cacheWriteTokens);
  return {
    input_tokens: Number(usage?.inputTokens ?? 0),
    output_tokens: Number(usage?.outputTokens ?? 0),
    cache_read_tokens: cacheRead || extractCacheRead(providerMetadata),
    cache_creation_tokens: cacheWrite || extractCacheCreation(providerMetadata),
  };
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
    this.modelId = this.opts.defaultModel?.trim() || initialModelId(this.opts);
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

  private async buildExtraTools(
    extras: SubkitLlmToolWithContext[] | undefined,
  ): Promise<Record<string, Tool> | undefined> {
    if (!extras || extras.length === 0) return undefined;
    const tools: Record<string, Tool> = {};
    for (const item of extras) {
      const def = item.toolDefinition;
      if (!("name" in (def as Record<string, unknown>))) {
        Object.assign(tools, def as Record<string, Tool>);
        continue;
      }
      const td = def as SubkitLlmToolDefinition;
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
    const palette = await compatibleToolPalette(tools);
    for (const name of palette.omitted)
      logger.warn({
        module: "llm",
        action: "tool.schema_incompatible",
        tool: name,
        msg: "Tool omitted because its input schema is incompatible with the model tool contract",
      });
    return palette.tools;
  }

  private async callWithFallback(params: {
    messages: SubkitLlmMessage[];
    temperature?: number;
    tools?: Record<string, Tool>;
    output?: GenerateTextOptions["output"];
    stopWhen?: GenerateTextOptions["stopWhen"];
    metadata?: SubkitLlmTelemetryMetadata;
    signal?: AbortSignal;
    maxOutputTokens?: number;
  }): Promise<SubkitLlmAnsweredBy & { result: GenerateTextOutcome }> {
    const primary = await this.ensureInit();
    const timeoutMs = this.opts.callTimeoutMs ?? LLM_CALL_TIMEOUT_MS;
    const isCallerAborted = () => params.signal?.aborted === true;
    const callOpts: GenerateTextOptions = {
      model: primary.model,
      messages: params.messages as ModelMessage[],
      maxRetries: this.opts.maxRetries ?? 0,
      timeout: { totalMs: timeoutMs },
      allowSystemInMessages: true,
    };
    if (params.signal) callOpts.abortSignal = params.signal;
    if (params.temperature !== undefined && !isReasoningModel(primary.modelId))
      callOpts.temperature = params.temperature;
    if (params.tools) callOpts.tools = params.tools;
    if (params.output) {
      callOpts.output = params.output;
      callOpts.providerOptions = {
        anthropic: { structuredOutputMode: "jsonTool" },
        openai: { strictJsonSchema: false },
      };
    }
    if (params.stopWhen) callOpts.stopWhen = params.stopWhen;
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
      const { temperature: _primaryTemperature, ...sharedOpts } = callOpts;
      const fbOpts: GenerateTextOptions = {
        ...sharedOpts,
        model: this.fallbackResolved.model,
      };
      const fallbackModelId = this.fallbackResolved.modelId;
      if (params.temperature !== undefined && !isReasoningModel(fallbackModelId))
        fbOpts.temperature = params.temperature;
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
      usage: usageOf(result.usage, result.providerMetadata),
    };
  }

  async generateObject<T>(
    input: SubkitLlmObjectGeneratorInput & { metadata?: SubkitLlmTelemetryMetadata },
  ): Promise<SubkitLlmObjectResponse<T>> {
    const { schema, wrappedInResult } = normalizeSchema(input.schema);
    const output = Output.object({
      schema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]),
    });

    const maxAttempts = input.maxAttempts ?? MAX_TOOL_LOOP_ATTEMPTS;

    const seeded = withCurrentDate(input.messages);
    const cwfParams: Parameters<typeof this.callWithFallback>[0] = {
      messages: seeded,
      output,
      tools: {
        ...((await this.buildExtraTools(input.tools)) ?? {}),
        [ABORT_TOOL_NAME]: abortTool(),
      },
      stopWhen: stepCountIs(maxAttempts),
    };
    cwfParams.temperature = input.temperature ?? 0;
    if (input.metadata) cwfParams.metadata = input.metadata;
    if (input.signal) cwfParams.signal = input.signal;
    if (input.maxOutputTokens !== undefined) cwfParams.maxOutputTokens = input.maxOutputTokens;

    let called: Awaited<ReturnType<typeof this.callWithFallback>>;
    try {
      called = await this.callWithFallback(cwfParams);
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err)) {
        return {
          success: false,
          response: `structured output rejected: ${err.message}`,
          messages: seeded,
          usage: usageOf(err.usage, undefined),
          model_used: this.modelId,
          fell_back: false,
        };
      }
      throw err;
    }
    const { result, ...answeredBy } = called;
    const responseMessages = (result.responseMessages ??
      result.response?.messages ??
      []) as unknown as SubkitLlmMessage[];
    const messages = [...seeded, ...responseMessages];
    const usage = usageOf(result.usage, result.providerMetadata);
    const steps = result.steps?.length ?? 1;

    const refusal = refusalOf(result.toolCalls);
    if (refusal !== null) {
      logger.warn({
        module: "llm",
        action: "structured.refused",
        msg: "model called the abort tool instead of producing the object",
        model: answeredBy.model_used,
        reason: refusal.reason,
        need_kinds: refusal.needs.map((need) => need.kind),
        steps,
        output_tokens: usage.output_tokens,
      });
      return {
        success: false,
        response: refusal.reason,
        abort: refusal,
        messages,
        usage,
        ...answeredBy,
      };
    }

    if (result.finishReason !== "stop") {
      return {
        success: false,
        response:
          result.finishReason === "tool-calls"
            ? `max_attempts_exceeded after ${steps} tool steps`
            : `LLM finished abnormally: ${result.finishReason}`,
        messages,
        usage,
        ...answeredBy,
      };
    }

    const value = unwrapResult<T>(result.output, wrappedInResult);
    if (value === null || value === undefined) {
      return { success: false, response: "empty_value", messages, usage, ...answeredBy };
    }
    return { success: true, response: value, messages, usage, ...answeredBy };
  }
}

const ABORT_TOOL_NAME = "abort";

function abortTool(): Tool {
  return tool({
    description:
      "Call this instead of producing the object when the task cannot be fulfilled from the given context. Name exactly what is missing or impossible in `reason`, and list each concrete missing fact in `needs` so the caller can fetch it or ask the user.",
    inputSchema: jsonSchema<GenerationAbort>(
      GENERATION_ABORT_INPUT_SCHEMA as unknown as Parameters<typeof jsonSchema>[0],
    ),
  });
}

function refusalOf(
  toolCalls: ReadonlyArray<{ toolName: string; input: unknown }> | undefined,
): GenerationAbort | null {
  const call = toolCalls?.find((c) => c.toolName === ABORT_TOOL_NAME);
  if (!call) return null;
  return parseGenerationAbort(call.input);
}

function extractCacheRead(meta: unknown): number {
  if (!meta || typeof meta !== "object") return 0;
  const m = meta as Record<string, Record<string, unknown>>;
  const anthUsage = m.anthropic?.usage as { cache_read_input_tokens?: number } | undefined;
  if (anthUsage?.cache_read_input_tokens) return Number(anthUsage.cache_read_input_tokens);
  const gwUsage = m.gateway?.usage as { cache_read_input_tokens?: number } | undefined;
  return Number(gwUsage?.cache_read_input_tokens ?? 0);
}

function extractCacheCreation(meta: unknown): number {
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
