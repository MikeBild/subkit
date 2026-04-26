// AiSdkModel unit tests — bun:test with an injected generateText mock
// via the constructor `generateTextFn` option (no SDK module mocking).

import { describe, expect, it } from "bun:test";
import { classifyProviderError, isFallbackEligible } from "../../provider-errors.ts";
import { AiSdkModel } from "../ai-sdk-model.ts";
import type { SubkitLlmMessage } from "../base-types.ts";

interface GenerateTextStubResult {
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: loose stub shape
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: any }>;
  toolResults?: Array<{ toolCallId: string; output: unknown }>;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  response?: { messages: SubkitLlmMessage[] };
  providerMetadata?: Record<string, Record<string, unknown>>;
}

function makeStub(result: GenerateTextStubResult) {
  const calls: unknown[] = [];
  const fn = async (opts: unknown) => {
    calls.push(opts);
    return {
      text: result.text ?? "",
      toolCalls: result.toolCalls ?? [],
      toolResults: result.toolResults ?? [],
      finishReason: result.finishReason ?? "stop",
      usage: result.usage ?? { inputTokens: 0, outputTokens: 0 },
      response: result.response ?? {
        messages: [{ role: "assistant", content: result.text ?? "" }],
      },
      providerMetadata: result.providerMetadata ?? {},
    };
  };
  return { fn, calls };
}

function makeMultiStub(results: GenerateTextStubResult[]) {
  const calls: unknown[] = [];
  let i = 0;
  const fn = async (opts: unknown) => {
    calls.push(opts);
    const r = results[Math.min(i, results.length - 1)] ?? { text: "" };
    i += 1;
    return {
      text: r.text ?? "",
      toolCalls: r.toolCalls ?? [],
      toolResults: r.toolResults ?? [],
      finishReason: r.finishReason ?? "stop",
      usage: r.usage ?? { inputTokens: 0, outputTokens: 0 },
      response: r.response ?? {
        messages: [{ role: "assistant", content: r.text ?? "" }],
      },
      providerMetadata: r.providerMetadata ?? {},
    };
  };
  return { fn, calls };
}

describe("AiSdkModel.generateText", () => {
  it("prepends the date, returns text + usage", async () => {
    const stub = makeStub({
      text: "hello",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const model = new AiSdkModel({
      defaultModel: "claude-sonnet-4-5",
      // biome-ignore lint/suspicious/noExplicitAny: stub replaces SDK
      generateTextFn: stub.fn as any,
    });
    const r = await model.generateText([{ role: "user", content: "hi" }]);
    expect(r.response).toBe("hello");
    expect(r.usage.input_tokens).toBe(10);
    expect(r.usage.output_tokens).toBe(2);

    const call = stub.calls[0] as { messages: SubkitLlmMessage[] };
    expect(call.messages[0]?.content).toMatch(/^The current date and time is /);
    expect(call.messages[1]?.content).toBe("hi");
  });

  it("honours temperature and metadata", async () => {
    const stub = makeStub({ text: "ok" });
    const model = new AiSdkModel({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    await model.generateText([{ role: "user", content: "x" }], {
      temperature: 0.7,
      metadata: { tenant_id: "t1", flow: "converse" },
    });
    const call = stub.calls[0] as {
      temperature: number;
      experimental_telemetry: { metadata: Record<string, unknown> };
    };
    expect(call.temperature).toBe(0.7);
    expect(call.experimental_telemetry.metadata.tenant_id).toBe("t1");
  });
});

describe("AiSdkModel.generateObject — submit-tool loop", () => {
  it("returns final result when the model calls submit", async () => {
    const stub = makeStub({
      text: "",
      toolCalls: [{ toolCallId: "c1", toolName: "submit", input: { key: "value" } }],
      finishReason: "tool-calls",
    });
    const model = new AiSdkModel({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const r = await model.generateObject({
      messages: [{ role: "user", content: "test" }],
      schema: { type: "object", properties: { key: { type: "string" } } },
    });
    expect(r.success).toBe(true);
    expect(r.response).toEqual({ key: "value" });

    const call = stub.calls[0] as {
      toolChoice: string;
      tools: Record<string, unknown>;
    };
    expect(call.toolChoice).toBe("required");
    expect(call.tools).toHaveProperty("submit");
    expect(call.tools).toHaveProperty("abort");
  });

  it("unwraps { result: [...] } when schema is array-rooted", async () => {
    const stub = makeStub({
      text: "",
      toolCalls: [{ toolCallId: "c1", toolName: "submit", input: { result: [1, 2, 3] } }],
      finishReason: "tool-calls",
    });
    const model = new AiSdkModel({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const r = await model.generateObject<number[]>({
      messages: [{ role: "user", content: "list" }],
      schema: { type: "array", items: { type: "number" } },
    });
    expect(r.success).toBe(true);
    expect(r.response).toEqual([1, 2, 3]);
  });

  it("returns success=false with abort reason when model aborts", async () => {
    const stub = makeStub({
      text: "",
      toolCalls: [{ toolCallId: "c1", toolName: "abort", input: { reason: "no can do" } }],
      finishReason: "tool-calls",
    });
    const model = new AiSdkModel({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const r = await model.generateObject({
      messages: [{ role: "user", content: "x" }],
      schema: { type: "object", properties: { key: { type: "string" } } },
    });
    expect(r.success).toBe(false);
    expect(r.response).toBe("no can do");
  });

  it("treats o-model temperature as undefined", async () => {
    const stub = makeStub({
      text: "",
      toolCalls: [{ toolCallId: "c1", toolName: "submit", input: { key: "value" } }],
      finishReason: "tool-calls",
    });
    const model = new AiSdkModel({
      defaultModel: "o1-preview",
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    await model.generateObject({
      messages: [{ role: "user", content: "x" }],
      schema: { type: "object", properties: { key: { type: "string" } } },
      temperature: 0.5,
    });
    const call = stub.calls[0] as { temperature: number | undefined };
    expect(call.temperature).toBeUndefined();
  });

  it("returns a clear failure when no tool calls arrive", async () => {
    const stub = makeStub({
      text: "just text",
      toolCalls: [],
      finishReason: "stop",
    });
    const model = new AiSdkModel({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const r = await model.generateObject({
      messages: [{ role: "user", content: "x" }],
      schema: { type: "object", properties: { key: { type: "string" } } },
    });
    expect(r.success).toBe(false);
  });

  it("continues the loop across non-submit tool calls up to maxUses", async () => {
    const stub = makeMultiStub([
      {
        text: "",
        toolCalls: [{ toolCallId: "c1", toolName: "echo", input: { v: 1 } }],
        finishReason: "tool-calls",
      },
      {
        text: "",
        toolCalls: [{ toolCallId: "c2", toolName: "submit", input: { ok: true } }],
        finishReason: "tool-calls",
      },
    ]);
    const model = new AiSdkModel({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const r = await model.generateObject<{ ok: boolean }>({
      messages: [{ role: "user", content: "x" }],
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
      tools: [
        {
          toolDefinition: {
            name: "echo",
            description: "echo",
            arguments: { type: "object", properties: { v: { type: "number" } } },
            execute: async (args) => args,
          },
          maxUses: 2,
        },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.response).toEqual({ ok: true });
    expect(stub.calls.length).toBe(2);
  });
});

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
