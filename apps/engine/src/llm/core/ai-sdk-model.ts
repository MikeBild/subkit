// AiSdkModel — single LLM-call abstraction for the engine.
//
//   - `generateText()` — simple text response, with broad-class fallback.
//   - `generateObject()` — schema-constrained response via the submit-tool
//     loop (`toolChoice: "required"`). Tolerant of providers that don't
//     support `generateObject` directly and works uniformly through the
//     gateway.
//   - `cleanSchema` normalisation before every structured call.
//   - Broad provider-error detection (5xx/429/503/timeout/keyword match).
//
// This file imports only from `ai`. Provider packages are loaded via
// `model-init.ts` on demand.

import { generateText, jsonSchema, NoSuchToolError, type Tool, tool } from "ai";
import { logger } from "../../logging/logger.ts";
import type {
  SubkitLlm,
  SubkitLlmMessage,
  SubkitLlmObjectGeneratorInput,
  SubkitLlmObjectResponse,
  SubkitLlmResponse,
  SubkitLlmTelemetryMetadata,
  SubkitLlmToolDefinition,
  SubkitLlmToolWithContext,
  SubkitProviderErrorKind,
} from "./base-types.ts";
import {
  initializeModel,
  type ModelInitOptions,
  ProviderMisconfiguredError,
  type ResolvedModel,
} from "./model-init.ts";
import { normalizeSchema, unwrapResult } from "./schema-normalizer.ts";

const PROVIDER_ERROR_PATTERNS = [
  "overloaded",
  "service unavailable",
  "timeout",
  "econnrefused",
  "etimedout",
  "rate limit",
  "temporarily unavailable",
  "internal server error",
  "503",
  "500",
  "502",
  "504",
  "529",
  "context_length",
  "too many tokens",
];

export function classifyProviderError(err: unknown): SubkitProviderErrorKind {
  const anyErr = err as { statusCode?: number; status?: number; message?: string } | undefined;
  const statusCode = anyErr?.statusCode ?? anyErr?.status;
  const msg = (anyErr?.message ?? String(err ?? "")).toLowerCase();

  if (msg.includes("context_length") || msg.includes("too many tokens")) {
    return "context_length_exceeded";
  }
  if (statusCode === 429 || msg.includes("rate limit")) return "rate_limit";
  if (msg.includes("overloaded") || statusCode === 529) return "overloaded";
  if (msg.includes("timeout") || msg.includes("etimedout")) return "timeout";
  if (statusCode && (statusCode >= 500 || statusCode === 503)) return "network_5xx";
  if (PROVIDER_ERROR_PATTERNS.some((p) => msg.includes(p))) return "network_5xx";
  return "other";
}

export function isFallbackEligible(err: unknown): boolean {
  const kind = classifyProviderError(err);
  return (
    kind === "rate_limit" ||
    kind === "overloaded" ||
    kind === "context_length_exceeded" ||
    kind === "network_5xx" ||
    kind === "timeout"
  );
}

const DEFAULT_MODEL_ID = "claude-sonnet-4-5";

// Hard cap on the submit/abort tool-use loop in `generateObject()`. Prevents a
// buggy or adversarial model from looping indefinitely when it keeps calling
// auxiliary tools without ever choosing `submit` or `abort`. Eight attempts is
// enough for a legitimate multi-step tool workflow and cheap to surface as a
// structured failure (reason = `max_attempts_exceeded`).
export const MAX_TOOL_LOOP_ATTEMPTS = 8;
const MODEL_CONTEXT_LENGTHS: Record<string, number> = {
  "claude-sonnet-4-5": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-opus-4-7": 200_000,
  "gpt-4o": 128_000,
  "gpt-4.1": 1_047_000,
  "o1-preview": 200_000,
  "o1-mini": 128_000,
};

function contextLengthFor(modelId: string): number {
  const bare = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
  return MODEL_CONTEXT_LENGTHS[bare] ?? 128_000;
}

function prependDate(messages: SubkitLlmMessage[]): SubkitLlmMessage[] {
  const first = messages[0]?.content;
  if (typeof first === "string" && first.startsWith("The current date and time is"))
    return messages;
  return [
    {
      role: "system",
      content: `The current date and time is ${new Date().toISOString()}`,
    },
    ...messages,
  ];
}

export interface AiSdkModelOptions extends ModelInitOptions {
  /**
   * Optional fallback model initialisation. When present, provider-error
   * classes trigger a single retry against this model before surfacing.
   */
  fallback?: ModelInitOptions;
  /** Max retries at the SDK layer. Default 0 — upstream handles retries. */
  maxRetries?: number;
  /** Override the `generateText` reference (used by unit tests). */
  generateTextFn?: typeof generateText;
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

  private async ensureInit(): Promise<void> {
    if (this.resolved) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.resolved = await initializeModel(this.opts);
        this.modelId = this.resolved.modelId;
        this.contextLength = contextLengthFor(this.modelId);
        if (this.opts.fallback) {
          try {
            this.fallbackResolved = await initializeModel(this.opts.fallback);
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
    return this.initPromise;
  }

  private buildTools(
    // biome-ignore lint/suspicious/noExplicitAny: ai sdk tool schema varies
    submitSchema: any,
    extras: SubkitLlmToolWithContext[] | undefined,
    usageCounts: Map<string, number>,
  ): Record<string, Tool> {
    const tools: Record<string, Tool> = {
      // biome-ignore lint/suspicious/noExplicitAny: ai sdk jsonSchema is Schema<any>
      submit: tool<any, any>({
        description:
          "Submit the final result in the required format. Submit even on error. Keep non-tool messages brief.",
        inputSchema: submitSchema,
      }) as Tool,
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
        // biome-ignore lint/suspicious/noExplicitAny: arbitrary schema shape
        inputSchema: jsonSchema(td.arguments as any),
      };
      tools[td.name] = td.execute
        ? (tool({
            ...baseSpec,
            execute: async (args: unknown) => td.execute!(args, item.toolContext),
            // biome-ignore lint/suspicious/noExplicitAny: ai sdk tool generic
          }) as any as Tool)
        : (tool(baseSpec) as Tool);
    }
    return tools;
  }

  private async callWithFallback(params: {
    messages: SubkitLlmMessage[];
    temperature?: number;
    tools?: Record<string, Tool>;
    toolChoice?: "auto" | "required" | "none" | { type: "tool"; toolName: string };
    metadata?: SubkitLlmTelemetryMetadata;
    // biome-ignore lint/suspicious/noExplicitAny: generic result
  }): Promise<any> {
    await this.ensureInit();
    const primary = this.resolved!;
    // biome-ignore lint/suspicious/noExplicitAny: ai sdk options shape
    const callOpts: any = {
      model: primary.model,
      messages: params.messages,
      maxRetries: this.opts.maxRetries ?? 0,
    };
    if (params.temperature !== undefined) callOpts.temperature = params.temperature;
    if (params.tools) callOpts.tools = params.tools;
    if (params.toolChoice) callOpts.toolChoice = params.toolChoice;
    if (params.metadata) {
      callOpts.experimental_telemetry = {
        isEnabled: true,
        functionId: String(params.metadata.flow ?? "unknown"),
        metadata: params.metadata as Record<string, string | number | boolean>,
      };
    }
    try {
      return await this.gt(callOpts);
    } catch (err) {
      if (!this.fallbackResolved || !isFallbackEligible(err)) throw err;
      logger.warn({
        module: "llm",
        action: "fallback.triggered",
        kind: classifyProviderError(err),
        primary: primary.modelId,
        fallback: this.fallbackResolved.modelId,
      });
      // biome-ignore lint/suspicious/noExplicitAny: ai sdk options shape
      const fbOpts: any = { ...callOpts, model: this.fallbackResolved.model };
      return await this.gt(fbOpts);
    }
  }

  async generateText(
    messages: SubkitLlmMessage[],
    opts?: { temperature?: number; metadata?: SubkitLlmTelemetryMetadata },
  ): Promise<SubkitLlmResponse> {
    const prepared = prependDate(messages);
    const params: Parameters<typeof this.callWithFallback>[0] = {
      messages: prepared,
      temperature: opts?.temperature ?? 0,
    };
    if (opts?.metadata) params.metadata = opts.metadata;
    const result = await this.callWithFallback(params);
    const newMessages = [
      ...prepared,
      ...((result.response.messages as unknown as SubkitLlmMessage[]) ?? []),
    ];
    return {
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

    const seeded = prependDate(input.messages);
    const convo: SubkitLlmMessage[] = [...seeded];

    let finalResult: T | undefined;
    let abortReason: string | undefined;
    let aggregatedUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    };

    const maxAttempts = input.maxAttempts ?? MAX_TOOL_LOOP_ATTEMPTS;
    let attempts = 0;
    while (finalResult === undefined && abortReason === undefined) {
      if (attempts >= maxAttempts) {
        return {
          success: false,
          response: `max_attempts_exceeded after ${attempts} tool-loop iterations`,
          messages: convo,
          usage: aggregatedUsage,
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
      const result = await this.callWithFallback(cwfParams);

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
        // Model produced neither submit nor tool calls — terminate with an
        // error rather than loop forever. Callers see a structured failure.
        return {
          success: false,
          response: "no tool calls produced by model",
          messages: convo,
          usage: aggregatedUsage,
        };
      }
    }

    if (abortReason !== undefined) {
      return {
        success: false,
        response: abortReason,
        messages: convo,
        usage: aggregatedUsage,
      };
    }

    return {
      success: true,
      response: finalResult as T,
      messages: convo,
      usage: aggregatedUsage,
    };
  }
}

function extractCacheRead(meta: unknown): number {
  if (!meta || typeof meta !== "object") return 0;
  const m = meta as Record<string, Record<string, unknown>>;
  // Anthropic direct
  const anthUsage = m.anthropic?.usage as { cache_read_input_tokens?: number } | undefined;
  if (anthUsage?.cache_read_input_tokens) return Number(anthUsage.cache_read_input_tokens);
  // Gateway may surface it under `gateway.usage` — best effort.
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
