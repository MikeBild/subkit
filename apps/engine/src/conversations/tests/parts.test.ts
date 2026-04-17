// Tests for the content-parts adapter — projects the flat
// `ConversationMessageRecord.content` JSONB into the parts-based
// `UIMessage` shape exposed on `messages_v2`.

import { describe, expect, test } from "bun:test";
import { buildMessagesV2, toMessageParts } from "../parts.ts";
import type { ConversationMessageRecord, ConversationToolCallRecord } from "../types.ts";

function msg(
  overrides: Partial<ConversationMessageRecord> & Pick<ConversationMessageRecord, "id" | "role">,
): ConversationMessageRecord {
  return {
    conversation_id: "conv-1",
    content: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function call(
  overrides: Partial<ConversationToolCallRecord> &
    Pick<ConversationToolCallRecord, "id" | "tool" | "created_at">,
): ConversationToolCallRecord {
  return {
    conversation_id: "conv-1",
    input: {},
    output: null,
    approval_required: false,
    ...overrides,
  };
}

describe("toMessageParts", () => {
  test("projects a string content into a single text part", () => {
    const ui = toMessageParts(msg({ id: "m1", role: "user", content: "hello" }), []);
    expect(ui.parts).toEqual([{ type: "text", text: "hello" }]);
  });

  test("extracts text from { text } wrapper objects", () => {
    const ui = toMessageParts(
      msg({ id: "m1", role: "assistant", content: { text: "hi there" } }),
      [],
    );
    expect(ui.parts).toEqual([{ type: "text", text: "hi there" }]);
  });

  test("emits empty parts for null/undefined content", () => {
    const ui = toMessageParts(msg({ id: "m1", role: "user", content: null }), []);
    expect(ui.parts).toEqual([]);
  });

  test("inlines tool calls + results as adjacent parts on assistant messages", () => {
    const ui = toMessageParts(msg({ id: "m1", role: "assistant", content: { text: "working" } }), [
      call({
        id: "call-1",
        tool: "listSkills",
        input: { scope: "tenant" },
        output: { count: 3 },
        created_at: "2026-01-01T00:00:01.000Z",
      }),
    ]);
    expect(ui.parts).toEqual([
      { type: "text", text: "working" },
      {
        type: "tool_call",
        call_id: "call-1",
        tool: "listSkills",
        input: { scope: "tenant" },
        phase: "result",
      },
      { type: "tool_result", call_id: "call-1", tool: "listSkills", output: { count: 3 } },
    ]);
  });

  test("does not attach tool calls to user messages", () => {
    const ui = toMessageParts(msg({ id: "m1", role: "user", content: "hello" }), [
      call({ id: "call-1", tool: "x", created_at: "2026-01-01T00:00:01.000Z" }),
    ]);
    expect(ui.parts).toEqual([{ type: "text", text: "hello" }]);
  });
});

describe("buildMessagesV2", () => {
  test("windows tool calls between adjacent messages by created_at", () => {
    const messages: ConversationMessageRecord[] = [
      msg({ id: "u1", role: "user", content: "first", created_at: "2026-01-01T00:00:00Z" }),
      msg({
        id: "a1",
        role: "assistant",
        content: { text: "running a tool" },
        created_at: "2026-01-01T00:00:01Z",
      }),
      msg({ id: "u2", role: "user", content: "second", created_at: "2026-01-01T00:00:05Z" }),
      msg({
        id: "a2",
        role: "assistant",
        content: { text: "running another" },
        created_at: "2026-01-01T00:00:06Z",
      }),
    ];
    const toolCalls: ConversationToolCallRecord[] = [
      call({ id: "c1", tool: "listSkills", created_at: "2026-01-01T00:00:02Z" }),
      call({ id: "c2", tool: "searchKnowledge", created_at: "2026-01-01T00:00:03Z" }),
      call({ id: "c3", tool: "listSkills", created_at: "2026-01-01T00:00:07Z" }),
    ];
    const out = buildMessagesV2(messages, toolCalls);
    expect(out).toHaveLength(4);
    expect(out[1]?.parts.filter((p) => p.type === "tool_call")).toHaveLength(2);
    expect(out[3]?.parts.filter((p) => p.type === "tool_call")).toHaveLength(1);
    expect(out[0]?.parts.filter((p) => p.type === "tool_call")).toHaveLength(0);
    expect(out[2]?.parts.filter((p) => p.type === "tool_call")).toHaveLength(0);
  });
});
