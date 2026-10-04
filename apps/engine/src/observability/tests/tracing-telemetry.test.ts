import { describe, expect, test } from "bun:test";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { generateText, registerTelemetry } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { OpenTelemetry } from "../../test-helpers/otel-telemetry.ts";
import { langfuseEnrich } from "../tracing.ts";

describe("langfuseEnrich — runtimeContext → langfuse.* attributes", () => {
  test("maps conversation→session and tenant/provider/model→trace metadata", () => {
    const attrs = langfuseEnrich({
      runtimeContext: {
        tenant_id: "T1",
        conversation_id: "C1",
        provider: "anthropic",
        model: "claude",
      },
    });
    expect(attrs).toEqual({
      "langfuse.session.id": "C1",
      "langfuse.trace.metadata.tenant_id": "T1",
      "langfuse.trace.metadata.provider": "anthropic",
      "langfuse.trace.metadata.model": "claude",
    });
  });

  test("returns undefined when there is no runtimeContext", () => {
    expect(langfuseEnrich({ runtimeContext: undefined })).toBeUndefined();
  });
});

describe("OpenTelemetry integration emits Langfuse-readable spans", () => {
  test("enrichSpan attrs + GenAI-semconv usage land on the exported span", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
    registerTelemetry(
      new OpenTelemetry({
        tracer: provider.getTracer("ai"),
        enrichSpan: langfuseEnrich,
        usage: true,
        providerMetadata: true,
      }),
    );

    const model = new MockLanguageModelV4({
      modelId: "m",
      provider: "p",
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 7, text: 7, reasoning: 0 },
        },
        warnings: [],
      }),
    });

    await generateText({
      model,
      messages: [{ role: "user", content: "hi" }],
      runtimeContext: { tenant_id: "T1", conversation_id: "C1", provider: "anthropic", model: "m" },
      telemetry: {
        isEnabled: true,
        functionId: "converse",
        includeRuntimeContext: {
          tenant_id: true,
          conversation_id: true,
          provider: true,
          model: true,
        },
      },
    });

    await provider.forceFlush();
    const attrs: Record<string, unknown> = {};
    for (const s of exporter.getFinishedSpans()) Object.assign(attrs, s.attributes);

    expect(attrs["langfuse.session.id"]).toBe("C1");
    expect(attrs["langfuse.trace.metadata.tenant_id"]).toBe("T1");
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(11);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(7);
    expect(attrs["gen_ai.request.model"]).toBeDefined();
  });
});
