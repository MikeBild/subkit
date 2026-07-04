// Unit tests for RC6: collectFromRows warns on genuinely unrecognized
// assistant turn content (null / number / boolean) but stays silent for
// structurally-valid no-text turns ({}, { _violations: [...] }, arrays,
// strings).
//
// collectFromRows is internal to suggest-next-emitter.ts and is reached
// via buildNextSuggestionFrame when no `db` is provided — the function
// then calls extractRecentMessages which calls collectFromRows. We
// capture logger.warn calls to assert the warn/no-warn boundary.

import { describe, expect, test } from "bun:test";
import { logger } from "../../logging/logger.ts";
import type { TurnEvent } from "../types.ts";
import { buildNextSuggestionFrame } from "./suggest-next-emitter.ts";

// Capture every logger.warn call during the action, restore after.
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

// Helpers for building a minimal events array with a synthetic
// assistant message carrying the given content value.
function eventsWithAssistantContent(content: unknown): ReadonlyArray<TurnEvent> {
  return [
    { type: "message", role: "user", content: { text: "hello" } },
    // Cast through unknown so tests can inject content shapes that
    // the narrow TurnEvent type doesn't accept (e.g. null, number).
    { type: "message", role: "assistant", content } as unknown as TurnEvent,
    { type: "completed", status: "active" } as TurnEvent,
  ];
}

// A no-op model invoker so we never call a real LLM. The only concern
// for these tests is whether logger.warn fires — the suggestion result
// is irrelevant.
const noopInvoker = async () => ({ text: null as unknown as string });

describe("suggest-next-emitter — content_shape_unrecognized warn boundary (RC6)", () => {
  // -----------------------------------------------------------------------
  // Benign no-text shapes — must NOT fire content_shape_unrecognized
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Genuinely unrecognized shapes — MUST fire content_shape_unrecognized
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Verify the frame still returns cleanly for all shapes (no throw)
  // -----------------------------------------------------------------------

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
