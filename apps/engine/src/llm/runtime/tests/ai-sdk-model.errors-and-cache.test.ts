import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { readStepUsage } from "../../../conversations/loop/usage.ts";
import { testEnv } from "../../../test-helpers/determinism/env.ts";
import { classifyProviderError, isFallbackEligible } from "../../provider-errors.ts";
import { AiSdkModel, usageOf } from "../ai-sdk-model.ts";
import type { SubkitLlmMessage } from "../base-types.ts";

let previousLlmProvider: string | undefined;

beforeAll(() => {
  previousLlmProvider = testEnv.LLM_PROVIDER;
  testEnv.LLM_PROVIDER = "mock";
});

afterAll(() => {
  if (previousLlmProvider === undefined) delete testEnv.LLM_PROVIDER;
  else testEnv.LLM_PROVIDER = previousLlmProvider;
});

interface GenerateTextStubResult {
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: loose stub shape
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: any }>;
  toolResults?: Array<{ toolCallId: string; output: unknown }>;
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  };
  response?: { messages: SubkitLlmMessage[] };
  responseMessages?: SubkitLlmMessage[];
  providerMetadata?: Record<string, Record<string, unknown>>;
  output?: unknown;
  steps?: unknown[];
}

interface StructuredCall {
  output?: { name: string; responseFormat: PromiseLike<{ type: string; schema: unknown }> };
  tools?: Record<string, unknown>;
  toolChoice?: unknown;
  stopWhen?: unknown;
  temperature?: number;
  timeout?: { totalMs?: number };
  abortSignal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
  maxOutputTokens?: number;
  model: unknown;
}

interface StrictSchemaNode {
  type?: unknown;
  properties?: Record<string, StrictSchemaNode>;
  required?: string[];
  additionalProperties?: unknown;
  items?: StrictSchemaNode;
  [key: string]: unknown;
}

function _expectStrictModeCompatible(node: StrictSchemaNode): void {
  for (const unsupported of ["minLength", "maxLength", "pattern", "format", "default"]) {
    expect(node).not.toHaveProperty(unsupported);
  }
  if (node.type === "object") {
    expect(node.additionalProperties).toBe(false);
    expect([...(node.required ?? [])].sort()).toEqual(Object.keys(node.properties ?? {}).sort());
    for (const child of Object.values(node.properties ?? {})) _expectStrictModeCompatible(child);
  }
  if (node.items) _expectStrictModeCompatible(node.items);
}

function stubResult(result: GenerateTextStubResult) {
  return {
    text: result.text ?? "",
    toolCalls: result.toolCalls ?? [],
    toolResults: result.toolResults ?? [],
    finishReason: result.finishReason ?? "stop",
    usage: result.usage ?? { inputTokens: 0, outputTokens: 0 },
    response: result.response ?? {
      messages: [{ role: "assistant", content: result.text ?? "" }],
    },
    ...(result.responseMessages ? { responseMessages: result.responseMessages } : {}),
    providerMetadata: result.providerMetadata ?? {},
    ...(result.steps ? { steps: result.steps } : {}),
    ...("output" in result ? { output: result.output } : {}),
  };
}

function makeStub(result: GenerateTextStubResult) {
  const calls: unknown[] = [];
  const fn = async (opts: unknown) => {
    calls.push(opts);
    return stubResult(result);
  };
  return { fn, calls };
}

function _outcome(value: unknown, text = JSON.stringify(value)) {
  return {
    text,
    finishReason: "stop",
    output: value,
  } satisfies GenerateTextStubResult;
}

function timeoutError(): Error {
  const err = new Error("The operation timed out");
  err.name = "TimeoutError";
  return err;
}

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function _makeTimeoutExpiredStub() {
  const calls: StructuredCall[] = [];
  const fn = (opts: StructuredCall) => {
    calls.push(opts);
    return opts.timeout?.totalMs === undefined
      ? Promise.reject(new Error("stub expected a typed timeout on the call"))
      : Promise.reject(timeoutError());
  };
  return { fn, calls };
}

function _makeAbortAwareStub() {
  const calls: StructuredCall[] = [];
  const fn = (opts: StructuredCall) => {
    calls.push(opts);
    return new Promise((_resolve, reject) => {
      const signal = opts.abortSignal;
      if (!signal) return;
      if (signal.aborted) return reject(abortError());
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  };
  return { fn, calls };
}

describe("classifyProviderError", () => {
  it("classifies rate_limit on 429", () => {
    expect(classifyProviderError({ statusCode: 429 })).toBe("rate_limit");
  });
  it("classifies rate_limit on keyword", () => {
    expect(classifyProviderError({ message: "rate limit exceeded" })).toBe("rate_limit");
  });
  it("classifies usage-limit wording as quota_exhausted", () => {
    expect(
      classifyProviderError({
        message: "You have reached your specified API usage limits. Try again later.",
      }),
    ).toBe("quota_exhausted");
  });
  it("classifies overloaded on 529", () => {
    expect(classifyProviderError({ statusCode: 529 })).toBe("overloaded");
  });
  it("classifies network_5xx on 500/502/503/504", () => {
    expect(classifyProviderError({ statusCode: 500 })).toBe("network_5xx");
    expect(classifyProviderError({ statusCode: 502 })).toBe("network_5xx");
    expect(classifyProviderError({ statusCode: 503 })).toBe("network_5xx");
    expect(classifyProviderError({ statusCode: 504 })).toBe("network_5xx");
  });
  it("classifies timeout on keyword", () => {
    expect(classifyProviderError({ message: "ETIMEDOUT happened" })).toBe("timeout");
  });
  it("classifies context_length_exceeded", () => {
    expect(classifyProviderError({ message: "context_length exceeded" })).toBe(
      "context_length_exceeded",
    );
  });
  it("classifies other as 'other'", () => {
    expect(classifyProviderError({ message: "something else" })).toBe("other");
  });
});

describe("isFallbackEligible", () => {
  it("returns true for retryable kinds", () => {
    expect(isFallbackEligible({ statusCode: 429 })).toBe(true);
    expect(isFallbackEligible({ statusCode: 500 })).toBe(true);
    expect(isFallbackEligible({ message: "usage limits reached" })).toBe(true);
    expect(isFallbackEligible({ message: "rate limit" })).toBe(true);
    expect(isFallbackEligible({ message: "overloaded" })).toBe(true);
    expect(isFallbackEligible({ message: "context_length" })).toBe(true);
  });
  it("returns false for unknown errors", () => {
    expect(isFallbackEligible({ message: "bad input" })).toBe(false);
  });
});

describe("AiSdkModel prompt-cache usage", () => {
  it("reads cache reads the provider reports only in the normalized usage", async () => {
    const stub = makeStub({
      text: "ok",
      usage: {
        inputTokens: 1_000,
        outputTokens: 5,
        inputTokenDetails: { cacheReadTokens: 800, cacheWriteTokens: 0 },
      },
      providerMetadata: { openai: { responseId: "r1" } },
    });
    const model = new AiSdkModel({
      defaultModel: "gpt-5-mini",
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const r = await model.generateText([{ role: "user", content: "hi" }]);
    expect(r.usage).toEqual({
      input_tokens: 1_000,
      output_tokens: 5,
      cache_read_tokens: 800,
      cache_creation_tokens: 0,
      cache_reported: true,
    });
  });

  it("takes one source for Anthropic cache figures, never their sum", () => {
    const usage = usageOf(
      {
        inputTokens: 1_200,
        outputTokens: 3,
        inputTokenDetails: { cacheReadTokens: 900, cacheWriteTokens: 200 },
      },
      { anthropic: { usage: { cache_read_input_tokens: 900, cache_creation_input_tokens: 200 } } },
    );
    expect(usage).toEqual({
      input_tokens: 1_200,
      output_tokens: 3,
      cache_read_tokens: 900,
      cache_creation_tokens: 200,
      cache_reported: true,
    });
  });

  it("preserves reporting presence through installed OpenAI and Anthropic adapters", async () => {
    for (const cached of [undefined, 0, 40]) {
      const openai = createOpenAI({
        apiKey: "test-key",
        fetch: Object.assign(
          async () =>
            Response.json({
              id: "chat-test",
              object: "chat.completion",
              created: 0,
              model: "gpt-4o",
              choices: [
                { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
              ],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 1,
                ...(cached === undefined
                  ? {}
                  : { prompt_tokens_details: { cached_tokens: cached } }),
              },
            }),
          { preconnect: () => {} },
        ),
      });
      const anthropic = createAnthropic({
        apiKey: "test-key",
        fetch: Object.assign(
          async () =>
            Response.json({
              id: "msg-test",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-5",
              content: [{ type: "text", text: "ok" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: {
                input_tokens: 100,
                output_tokens: 1,
                ...(cached === undefined ? {} : { cache_read_input_tokens: cached }),
              },
            }),
          { preconnect: () => {} },
        ),
      });
      for (const model of [openai.chat("gpt-4o"), anthropic("claude-sonnet-4-5")]) {
        const result = await generateText({ model, prompt: "hello", maxRetries: 0 });
        expect(result.usage.inputTokenDetails.cacheReadTokens).toBe(cached ?? 0);
        expect(usageOf(result.usage, result.providerMetadata).cache_reported).toBe(
          cached !== undefined,
        );
        expect(readStepUsage(result.steps[0]!).cacheReported).toBe(cached !== undefined);
      }
    }
  });

  it("uses raw provider usage to distinguish omitted cache counts from explicit zero", () => {
    for (const [raw, reported] of [
      [{ prompt_tokens: 500, completion_tokens: 2 }, false],
      [{ input_tokens: 500, output_tokens: 2 }, false],
      [{ prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 0 } }, true],
      [{ input_tokens: 500, input_tokens_details: { cached_tokens: 0 } }, true],
      [{ input_tokens: 500, cache_read_input_tokens: 0 }, true],
    ] as const) {
      expect(
        usageOf({ inputTokens: 500, inputTokenDetails: { cacheReadTokens: 0 }, raw }, undefined)
          .cache_reported,
      ).toBe(reported);
    }
  });

  it("marks cache figures as unreported when neither usage nor metadata carries them", () => {
    expect(usageOf({ inputTokens: 500, outputTokens: 2 }, undefined).cache_reported).toBe(false);
    expect(
      usageOf({ inputTokens: 500, inputTokenDetails: { cacheReadTokens: 0 } }, undefined)
        .cache_reported,
    ).toBe(true);
  });

  it("falls back to the provider metadata when the normalized usage has no cache details", () => {
    const usage = usageOf(
      { inputTokens: 500, outputTokens: 2 },
      { anthropic: { usage: { cache_read_input_tokens: 400, cache_creation_input_tokens: 50 } } },
    );
    expect(usage.cache_read_tokens).toBe(400);
    expect(usage.cache_creation_tokens).toBe(50);
    expect(usage.cache_reported).toBe(true);
  });
});
