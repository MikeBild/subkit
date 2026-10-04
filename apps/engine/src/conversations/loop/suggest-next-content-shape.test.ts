import { describe, expect, test } from "bun:test";
import { logger } from "../../logging/logger.ts";
import type { TurnEvent } from "../types.ts";
import { buildNextSuggestionFrame } from "./suggest-next-emitter.ts";

async function captureWarns(fn: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const captured: Array<Record<string, unknown>> = [];
  // biome-ignore lint/suspicious/noExplicitAny: logger spy
  const priorWarn: any = logger.warn.bind(logger);
  // biome-ignore lint/suspicious/noExplicitAny: logger spy
  (logger as any).warn = (payload: Record<string, unknown>) => {
    captured.push(payload);
    return priorWarn(payload);
  };
  try {
    await fn();
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore logger
    (logger as any).warn = priorWarn;
  }
  return captured;
}

function eventsWithAssistantContent(content: unknown): ReadonlyArray<TurnEvent> {
  return [
    { type: "message", role: "user", content: { text: "hello" } },
    { type: "message", role: "assistant", content } as unknown as TurnEvent,
    { type: "completed", status: "active" } as TurnEvent,
  ];
}

const noopInvoker = async () => ({ text: null as unknown as string });

describe("suggest-next-emitter — content_shape_unrecognized warn boundary (RC6)", () => {
  test("empty object content {} does NOT warn", async () => {
    const warns = await captureWarns(async () => {
      await buildNextSuggestionFrame({
        tenant_id: "t",
        conversation_id: "c",
        events: eventsWithAssistantContent({}),
        model_invoker: noopInvoker,
      });
    });
    const unrecognized = warns.filter(
      (w) => w.action === "suggest_next.content_shape_unrecognized",
    );
    expect(unrecognized).toHaveLength(0);
  });

  test("object with _violations field does NOT warn", async () => {
    const warns = await captureWarns(async () => {
      await buildNextSuggestionFrame({
        tenant_id: "t",
        conversation_id: "c",
        events: eventsWithAssistantContent({ _violations: [{ kind: "tool.phantom_reference" }] }),
        model_invoker: noopInvoker,
      });
    });
    const unrecognized = warns.filter(
      (w) => w.action === "suggest_next.content_shape_unrecognized",
    );
    expect(unrecognized).toHaveLength(0);
  });

  test("empty string content does NOT warn", async () => {
    const warns = await captureWarns(async () => {
      await buildNextSuggestionFrame({
        tenant_id: "t",
        conversation_id: "c",
        events: eventsWithAssistantContent(""),
        model_invoker: noopInvoker,
      });
    });
    const unrecognized = warns.filter(
      (w) => w.action === "suggest_next.content_shape_unrecognized",
    );
    expect(unrecognized).toHaveLength(0);
  });

  test("empty array content does NOT warn", async () => {
    const warns = await captureWarns(async () => {
      await buildNextSuggestionFrame({
        tenant_id: "t",
        conversation_id: "c",
        events: eventsWithAssistantContent([]),
        model_invoker: noopInvoker,
      });
    });
    const unrecognized = warns.filter(
      (w) => w.action === "suggest_next.content_shape_unrecognized",
    );
    expect(unrecognized).toHaveLength(0);
  });

  test("null content fires content_shape_unrecognized warn", async () => {
    const warns = await captureWarns(async () => {
      await buildNextSuggestionFrame({
        tenant_id: "t",
        conversation_id: "c",
        events: eventsWithAssistantContent(null),
        model_invoker: noopInvoker,
      });
    });
    const unrecognized = warns.filter(
      (w) => w.action === "suggest_next.content_shape_unrecognized",
    );
    expect(unrecognized.length).toBeGreaterThanOrEqual(1);
    expect(unrecognized[0]?.content_kind).toBe("object");
  });

  test("number content fires content_shape_unrecognized warn", async () => {
    const warns = await captureWarns(async () => {
      await buildNextSuggestionFrame({
        tenant_id: "t",
        conversation_id: "c",
        events: eventsWithAssistantContent(42),
        model_invoker: noopInvoker,
      });
    });
    const unrecognized = warns.filter(
      (w) => w.action === "suggest_next.content_shape_unrecognized",
    );
    expect(unrecognized.length).toBeGreaterThanOrEqual(1);
    expect(unrecognized[0]?.content_kind).toBe("number");
  });

  test("boolean content fires content_shape_unrecognized warn", async () => {
    const warns = await captureWarns(async () => {
      await buildNextSuggestionFrame({
        tenant_id: "t",
        conversation_id: "c",
        events: eventsWithAssistantContent(false),
        model_invoker: noopInvoker,
      });
    });
    const unrecognized = warns.filter(
      (w) => w.action === "suggest_next.content_shape_unrecognized",
    );
    expect(unrecognized.length).toBeGreaterThanOrEqual(1);
    expect(unrecognized[0]?.content_kind).toBe("boolean");
  });

  test("returns a next_suggestion frame for any content shape — never throws", async () => {
    const shapes = [{}, { _violations: [] }, null, 42, false, "", []];
    for (const content of shapes) {
      const frame = await buildNextSuggestionFrame({
        tenant_id: "t",
        conversation_id: "c",
        events: eventsWithAssistantContent(content),
        model_invoker: noopInvoker,
      });
      expect(frame.type).toBe("next_suggestion");
    }
  });
});
