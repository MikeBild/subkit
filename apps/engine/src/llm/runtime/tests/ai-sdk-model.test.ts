import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { testEnv } from "../../../test-helpers/determinism/env.ts";
import { AiSdkModel, isReasoningModel, LlmCallAbortedError } from "../ai-sdk-model.ts";
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

function makeTimeoutExpiredStub() {
  const calls: StructuredCall[] = [];
  const fn = (opts: StructuredCall) => {
    calls.push(opts);
    return opts.timeout?.totalMs === undefined
      ? Promise.reject(new Error("stub expected a typed timeout on the call"))
      : Promise.reject(timeoutError());
  };
  return { fn, calls };
}

function makeAbortAwareStub() {
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

describe("AiSdkModel per-call timeout + abort", () => {
  it("surfaces the SDK timeout as a typed error that is not a caller abort", async () => {
    const stub = makeTimeoutExpiredStub();
    const model = new AiSdkModel({
      defaultModel: "claude-sonnet-4-5",
      callTimeoutMs: 40,
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const err = await model.generateText([{ role: "user", content: "hi" }]).catch((e) => e);
    expect(err).toBeInstanceOf(LlmCallAbortedError);
    expect((err as Error).message).toContain("timeout");
    expect((err as Error).message).not.toBe("llm call aborted (caller signal)");
    expect(stub.calls[0]?.timeout).toEqual({ totalMs: 40 });
  });

  it("propagates a caller-supplied signal abort promptly", async () => {
    const stub = makeAbortAwareStub();
    const model = new AiSdkModel({
      defaultModel: "claude-sonnet-4-5",
      callTimeoutMs: 60_000,
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const controller = new AbortController();
    const p = model.generateText([{ role: "user", content: "hi" }], {
      signal: controller.signal,
    });
    queueMicrotask(() => controller.abort());
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(LlmCallAbortedError);
    expect((err as Error).message).toBe("llm call aborted (caller signal)");
  });

  it("passes the typed total timeout and the caller signal unchanged to the provider call", async () => {
    const stub = makeStub({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 } });
    const model = new AiSdkModel({
      defaultModel: "claude-sonnet-4-5",
      callTimeoutMs: 1234,
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const controller = new AbortController();
    await model.generateText([{ role: "user", content: "hi" }], { signal: controller.signal });
    const call = stub.calls[0] as StructuredCall;
    expect(call.timeout).toEqual({ totalMs: 1234 });
    expect(call.abortSignal).toBe(controller.signal);

    await model.generateText([{ role: "user", content: "hi" }]);
    const second = stub.calls[1] as StructuredCall;
    expect(second.timeout).toEqual({ totalMs: 1234 });
    expect(second.abortSignal).toBeUndefined();
  });

  it("does not regress a normal fast call", async () => {
    const stub = makeStub({ text: "hello", usage: { inputTokens: 5, outputTokens: 2 } });
    const model = new AiSdkModel({
      defaultModel: "claude-sonnet-4-5",
      callTimeoutMs: 50,
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const r = await model.generateText([{ role: "user", content: "hi" }]);
    expect(r.response).toBe("hello");
    expect(r.usage.input_tokens).toBe(5);
  });

  it("bounds the fallback model call with the same typed timeout", async () => {
    const calls: StructuredCall[] = [];
    let i = 0;
    const fn = (opts: StructuredCall) => {
      calls.push(opts);
      i += 1;
      if (i === 1) return Promise.reject(new Error("overloaded"));
      return Promise.reject(timeoutError());
    };
    const model = new AiSdkModel({
      defaultModel: "claude-sonnet-4-5",
      callTimeoutMs: 40,
      fallback: { defaultModel: "claude-sonnet-4-6" },
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: fn as any,
    });
    await expect(model.generateText([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(
      LlmCallAbortedError,
    );
    expect(calls.length).toBe(2);
    expect(calls[0]?.timeout).toEqual({ totalMs: 40 });
    expect(calls[1]?.timeout).toEqual({ totalMs: 40 });
  });
});

describe("isReasoningModel", () => {
  it("matches o-series and GPT-5 models with or without a provider prefix", () => {
    for (const id of [
      "o1-preview",
      "o3-mini",
      "gpt-5.6-sol",
      "openai:gpt-5-mini",
      "openai/o4-mini",
    ])
      expect(isReasoningModel(id)).toBe(true);
    for (const id of ["gpt-4o", "claude-sonnet-4-5", "openai:gpt-4.1", "ollama"])
      expect(isReasoningModel(id)).toBe(false);
  });
});

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

  it("omits the default temperature for a GPT-5 reasoning model", async () => {
    const stub = makeStub({ text: "ok" });
    const model = new AiSdkModel({
      defaultModel: "gpt-5.6-sol",
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    await model.generateText([{ role: "user", content: "x" }]);
    expect("temperature" in (stub.calls[0] as object)).toBe(false);
  });

  it("keeps the temperature for a non-reasoning fallback after a reasoning primary fails", async () => {
    const calls: Array<{ temperature?: number }> = [];
    let i = 0;
    const fn = async (opts: { temperature?: number }) => {
      calls.push(opts);
      i += 1;
      if (i === 1) throw new Error("overloaded");
      return stubResult({ text: "ok" });
    };
    const model = new AiSdkModel({
      defaultModel: "gpt-5.6-sol",
      fallback: { defaultModel: "gpt-4.1" },
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: fn as any,
    });
    const r = await model.generateText([{ role: "user", content: "x" }], { temperature: 0.3 });
    expect(r.fell_back).toBe(true);
    expect("temperature" in (calls[0] ?? {})).toBe(false);
    expect(calls[1]?.temperature).toBe(0.3);
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
      telemetry: { functionId: string; includeRuntimeContext: Record<string, unknown> };
      runtimeContext: Record<string, unknown>;
    };
    expect(call.temperature).toBe(0.7);
    expect(call.runtimeContext.tenant_id).toBe("t1");
    expect(call.telemetry.functionId).toBe("converse");
    expect(call.telemetry.includeRuntimeContext.tenant_id).toBe(true);
  });
});
