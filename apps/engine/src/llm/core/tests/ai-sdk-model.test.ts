import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type generateText, NoObjectGeneratedError } from "ai";
import { classifyProviderError, isFallbackEligible } from "../../provider-errors.ts";
import { AiSdkModel, LlmCallAbortedError } from "../ai-sdk-model.ts";
import type { SubkitLlmMessage } from "../base-types.ts";

let previousLlmProvider: string | undefined;

beforeAll(() => {
  previousLlmProvider = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = "mock";
});

afterAll(() => {
  if (previousLlmProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = previousLlmProvider;
});

interface GenerateTextStubResult {
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: loose stub shape
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: any }>;
  toolResults?: Array<{ toolCallId: string; output: unknown }>;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
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

function expectStrictModeCompatible(node: StrictSchemaNode): void {
  for (const unsupported of ["minLength", "maxLength", "pattern", "format", "default"]) {
    expect(node).not.toHaveProperty(unsupported);
  }
  if (node.type === "object") {
    expect(node.additionalProperties).toBe(false);
    expect([...(node.required ?? [])].sort()).toEqual(Object.keys(node.properties ?? {}).sort());
    for (const child of Object.values(node.properties ?? {})) expectStrictModeCompatible(child);
  }
  if (node.items) expectStrictModeCompatible(node.items);
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

function outcome(value: unknown, text = JSON.stringify(value)) {
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
      telemetry: { functionId: string; includeRuntimeContext: Record<string, unknown> };
      runtimeContext: Record<string, unknown>;
    };
    expect(call.temperature).toBe(0.7);
    expect(call.runtimeContext.tenant_id).toBe("t1");
    expect(call.telemetry.functionId).toBe("converse");
    expect(call.telemetry.includeRuntimeContext.tenant_id).toBe(true);
  });
});

describe("AiSdkModel.generateObject — structured outcome", () => {
  const keySchema = { type: "object", properties: { key: { type: "string" } } };

  it("preserves an explicit output cap without changing uncapped callers", async () => {
    const stub = makeStub(outcome({ key: "value" }));
    const model = new AiSdkModel({ generateTextFn: stub.fn as typeof generateText });
    await model.generateObject({
      messages: [{ role: "user", content: "test" }],
      schema: keySchema,
      maxOutputTokens: 512,
    });
    expect((stub.calls[0] as StructuredCall).maxOutputTokens).toBe(512);
    await model.generateObject({
      messages: [{ role: "user", content: "test" }],
      schema: keySchema,
    });
    expect(stub.calls[1]).not.toHaveProperty("maxOutputTokens");
  });

  it("returns the parsed value from a single model call and always offers the abort tool", async () => {
    const stub = makeStub(outcome({ key: "value" }));
    const model = new AiSdkModel({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const r = await model.generateObject({
      messages: [{ role: "user", content: "test" }],
      schema: keySchema,
    });
    expect(r.success).toBe(true);
    expect(r.response).toEqual({ key: "value" });
    expect(stub.calls.length).toBe(1);

    const call = stub.calls[0] as StructuredCall;
    expect(call.toolChoice).toBeUndefined();
    expect(Object.keys(call.tools ?? {})).toEqual(["abort"]);
    expect(typeof call.stopWhen).toBe("function");
    expect(call.output?.name).toBe("object");
  });

  it("asks Anthropic for tool-based output and OpenAI for non-strict schemas so a workflow schema with optional fields is accepted", async () => {
    const stub = makeStub(outcome({ key: "value" }));
    const model = new AiSdkModel({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    await model.generateObject({
      messages: [{ role: "user", content: "test" }],
      schema: keySchema,
    });
    const structured = stub.calls[0] as StructuredCall;
    expect(structured.providerOptions).toEqual({
      anthropic: { structuredOutputMode: "jsonTool" },
      openai: { strictJsonSchema: false },
    });

    await model.generateText([{ role: "user", content: "hi" }]);
    const plain = stub.calls[1] as StructuredCall;
    expect(plain.providerOptions).toBeUndefined();
  });

  it("sends the value schema itself on the wire and an abort tool that demands a reason", async () => {
    const stub = makeStub(outcome({ key: "value" }));
    const model = new AiSdkModel({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    await model.generateObject({
      messages: [{ role: "user", content: "test" }],
      schema: keySchema,
    });
    const call = stub.calls[0] as StructuredCall;
    const format = await call.output!.responseFormat;
    expect(format.type).toBe("json");
    expect(format.schema).toEqual({
      type: "object",
      properties: { key: { type: "string" } },
      additionalProperties: false,
    });
    const abort = (call.tools as Record<string, { description?: string; inputSchema: unknown }>)
      .abort!;
    expect(abort.description).toContain("cannot be fulfilled");
    const abortSchema = (abort.inputSchema as { jsonSchema: StrictSchemaNode }).jsonSchema;
    expect(abortSchema.required).toEqual(["reason", "needs"]);
    expect(abortSchema.properties?.reason).toMatchObject({ type: "string" });
    expectStrictModeCompatible(abortSchema);
    const item = abortSchema.properties?.needs?.items as StrictSchemaNode;
    expect(item.required).toEqual(["kind", "connector_slug", "method", "path", "question"]);
    expect(item.properties?.path).toMatchObject({ type: ["string", "null"] });
  });

  it("returns the structured needs when the model aborts with them", async () => {
    const stub = makeStub({
      text: "",
      finishReason: "tool-calls",
      toolCalls: [
        {
          toolCallId: "c1",
          toolName: "abort",
          input: {
            reason: "the send route contract is missing",
            needs: [
              {
                kind: "endpoint_contract",
                connector_slug: "mail",
                method: "post",
                path: "/v1/messages/send",
                question: null,
              },
              { kind: "user_fact", question: "Who receives the report?" },
              { kind: "unknown_kind", path: "/x" },
            ],
          },
        },
      ],
    });
    const model = new AiSdkModel({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const r = await model.generateObject({
      messages: [{ role: "user", content: "x" }],
      schema: keySchema,
    });
    expect(r.success).toBe(false);
    expect(r.response).toBe("the send route contract is missing");
    expect(r.abort).toEqual({
      reason: "the send route contract is missing",
      needs: [
        {
          kind: "endpoint_contract",
          connector_slug: "mail",
          method: "POST",
          path: "/v1/messages/send",
          question: null,
        },
        {
          kind: "user_fact",
          connector_slug: null,
          method: null,
          path: null,
          question: "Who receives the report?",
        },
      ],
    });
  });

  it("unwraps { result: [...] } when the value schema is array-rooted", async () => {
    const stub = makeStub(outcome({ result: [1, 2, 3] }));
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

  it("returns success=false with the reason when the model calls the abort tool", async () => {
    const stub = makeStub({
      text: "",
      finishReason: "tool-calls",
      toolCalls: [{ toolCallId: "c1", toolName: "abort", input: { reason: "no can do" } }],
    });
    const model = new AiSdkModel({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const r = await model.generateObject({
      messages: [{ role: "user", content: "x" }],
      schema: keySchema,
    });
    expect(r.success).toBe(false);
    expect(r.response).toBe("no can do");
  });

  it("treats a null object as empty_value", async () => {
    const stub = makeStub(outcome(null));
    const model = new AiSdkModel({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const r = await model.generateObject({
      messages: [{ role: "user", content: "x" }],
      schema: keySchema,
    });
    expect(r.success).toBe(false);
    expect(r.response).toBe("empty_value");
  });

  it("treats o-model temperature as undefined", async () => {
    const stub = makeStub(outcome({ key: "value" }));
    const model = new AiSdkModel({
      defaultModel: "o1-preview",
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    await model.generateObject({
      messages: [{ role: "user", content: "x" }],
      schema: keySchema,
      temperature: 0.5,
    });
    const call = stub.calls[0] as StructuredCall;
    expect(call.temperature).toBeUndefined();
  });

  it("reports an abnormal finish instead of reading output", async () => {
    const stub = makeStub({ text: "", finishReason: "length" });
    const model = new AiSdkModel({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const r = await model.generateObject({
      messages: [{ role: "user", content: "x" }],
      schema: keySchema,
    });
    expect(r.success).toBe(false);
    expect(r.response).toBe("LLM finished abnormally: length");
  });

  it("reports a schema rejection from the SDK as a failed outcome", async () => {
    const stub = {
      fn: async () => {
        throw new NoObjectGeneratedError({
          message: "No object generated: response did not match schema.",
          text: "{}",
          response: { id: "r1", timestamp: new Date(0), modelId: "m" },
          usage: { inputTokens: 7, outputTokens: 1 },
          finishReason: "stop",
        } as unknown as ConstructorParameters<typeof NoObjectGeneratedError>[0]);
      },
    };
    const model = new AiSdkModel({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const r = await model.generateObject({
      messages: [{ role: "user", content: "x" }],
      schema: keySchema,
    });
    expect(r.success).toBe(false);
    expect(String(r.response)).toContain("structured output rejected");
    expect(r.usage.input_tokens).toBe(7);
  });

  it("falls back to the secondary model on a primary provider error", async () => {
    let i = 0;
    const calls: StructuredCall[] = [];
    const fn = async (opts: StructuredCall) => {
      calls.push(opts);
      i += 1;
      if (i === 1) throw new Error("overloaded");
      return stubResult(outcome({ key: "from-fallback" }));
    };
    const model = new AiSdkModel({
      defaultModel: "claude-sonnet-4-5",
      fallback: { defaultModel: "claude-sonnet-4-6" },
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: fn as any,
    });
    const r = await model.generateObject({
      messages: [{ role: "user", content: "x" }],
      schema: keySchema,
    });
    expect(r.success).toBe(true);
    expect(r.response).toEqual({ key: "from-fallback" });
    expect(r.fell_back).toBe(true);
    expect(r.model_used).toBe("claude-sonnet-4-6");
    expect(r.primary_error).toBe("overloaded");
    expect(calls).toHaveLength(2);
  });

  it("keeps extra tools in the palette and bounds the steps with stepCountIs(maxAttempts)", async () => {
    const stub = makeStub({
      ...outcome({ ok: true }),
      toolCalls: [{ toolCallId: "c1", toolName: "echo", input: { v: 1 } }],
      steps: [{}, {}],
    });
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
      maxAttempts: 3,
      tools: [
        {
          toolDefinition: {
            name: "echo",
            description: "echo",
            arguments: { type: "object", properties: { v: { type: "number" } } },
            execute: async (args) => args,
          },
        },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.response).toEqual({ ok: true });
    expect(stub.calls.length).toBe(1);
    const call = stub.calls[0] as StructuredCall;
    expect(Object.keys(call.tools ?? {})).toEqual(["echo", "abort"]);
    expect(call.toolChoice).toBeUndefined();
    expect(typeof call.stopWhen).toBe("function");
    const stop = call.stopWhen as (o: { steps: unknown[] }) => boolean;
    expect(stop({ steps: [{}, {}] })).toBe(false);
    expect(stop({ steps: [{}, {}, {}] })).toBe(true);
  });

  it("reports the step cap when the model is still calling tools at the last step", async () => {
    const stub = makeStub({
      text: "",
      finishReason: "tool-calls",
      toolCalls: [{ toolCallId: "c1", toolName: "echo", input: { v: 1 } }],
      steps: [{}, {}, {}],
    });
    const model = new AiSdkModel({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const r = await model.generateObject({
      messages: [{ role: "user", content: "x" }],
      schema: keySchema,
      maxAttempts: 3,
      tools: [
        {
          toolDefinition: {
            name: "echo",
            description: "echo",
            arguments: { type: "object", properties: { v: { type: "number" } } },
            execute: async (args) => args,
          },
        },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.response).toBe("max_attempts_exceeded after 3 tool steps");
  });

  it("threads the accumulated response messages of every step", async () => {
    const stub = makeStub({
      ...outcome({ key: "value" }),
      responseMessages: [
        { role: "assistant", content: "calling echo" },
        { role: "tool", content: "echoed" },
        { role: "assistant", content: JSON.stringify({ ok: true, value: { key: "value" } }) },
      ],
    });
    const model = new AiSdkModel({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      generateTextFn: stub.fn as any,
    });
    const r = await model.generateObject({
      messages: [{ role: "user", content: "x" }],
      schema: keySchema,
    });
    expect(r.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
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
