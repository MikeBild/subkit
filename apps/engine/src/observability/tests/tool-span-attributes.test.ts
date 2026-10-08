import { afterAll, describe, expect, test } from "bun:test";
import { context, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { enrichActiveSpan, toolSpanAttributes } from "../tracing.ts";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

describe("tool span attributes", () => {
  test("rule, mode and duration land on the agreed keys; what is missing is left out", () => {
    expect(
      toolSpanAttributes({
        rule: "category_default",
        mode: "confirm_before_execution",
        duration_ms: 12.6,
      }),
    ).toEqual({
      "tool_policy.rule": "category_default",
      "tool_policy.mode": "confirm_before_execution",
      "tool.duration_ms": 13,
    });
    expect(toolSpanAttributes({ duration_ms: 40 })).toEqual({ "tool.duration_ms": 40 });
    expect(toolSpanAttributes({ duration_ms: Number.NaN })).toEqual({});
  });

  test("enrichActiveSpan writes onto the active span and is a no-op without one", async () => {
    enrichActiveSpan({ "tool.duration_ms": 1 });
    await provider.getTracer("test").startActiveSpan("tool.execute", async (span) => {
      enrichActiveSpan(
        toolSpanAttributes({
          rule: "held_writes",
          mode: "confirm_before_execution",
          duration_ms: 40,
        }),
      );
      span.end();
    });
    const [exported] = exporter.getFinishedSpans();
    expect(exported?.name).toBe("tool.execute");
    expect(exported?.attributes).toMatchObject({
      "tool_policy.rule": "held_writes",
      "tool_policy.mode": "confirm_before_execution",
      "tool.duration_ms": 40,
    });
  });
});
