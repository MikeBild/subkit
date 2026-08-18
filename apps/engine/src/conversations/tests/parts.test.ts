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
    confirmation_state: null,
    approved_at: null,
    outcome: null,
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
      {
        type: "tool_result",
        call_id: "call-1",
        tool: "listSkills",
        output: { count: 3 },
        outcome: null,
      },
    ]);
  });

  test("does not attach tool calls to user messages", () => {
    const ui = toMessageParts(msg({ id: "m1", role: "user", content: "hello" }), [
      call({ id: "call-1", tool: "x", created_at: "2026-01-01T00:00:01.000Z" }),
    ]);
    expect(ui.parts).toEqual([{ type: "text", text: "hello" }]);
  });
});

describe("buildMessagesV2 with parent_message_id (engine migration 0032)", () => {
  test("groups tool calls by explicit parent_message_id, ignoring created_at order", () => {
    const messages: ConversationMessageRecord[] = [
      msg({ id: "u1", role: "user", content: "first", created_at: "2026-01-01T00:00:00Z" }),
      msg({
        id: "a1",
        role: "assistant",
        content: { text: "calling a tool" },
        created_at: "2026-01-01T00:00:01Z",
      }),
      msg({
        id: "a2",
        role: "assistant",
        content: { text: "second turn" },
        created_at: "2026-01-01T00:00:05Z",
      }),
    ];
    // Note: created_at is INTENTIONALLY out of order vs. parent_message_id
    // — exercises that we trust the explicit anchor over the timestamp
    // window. This is the bug the migration fixes.
    const toolCalls: ConversationToolCallRecord[] = [
      call({
        id: "c1",
        tool: "listSkills",
        parent_message_id: "a1",
        created_at: "2026-01-01T00:00:09Z",
      }),
      call({
        id: "c2",
        tool: "searchKnowledge",
        parent_message_id: "a2",
        created_at: "2026-01-01T00:00:02Z",
      }),
    ];
    const out = buildMessagesV2(messages, toolCalls);
    const a1Parts = out.find((m) => m.id === "a1")?.parts ?? [];
    const a2Parts = out.find((m) => m.id === "a2")?.parts ?? [];
    expect(
      a1Parts.filter((p) => p.type === "tool_call").map((p) => (p as { call_id: string }).call_id),
    ).toEqual(["c1"]);
    expect(
      a2Parts.filter((p) => p.type === "tool_call").map((p) => (p as { call_id: string }).call_id),
    ).toEqual(["c2"]);
  });

  test("ignores unanchored legacy rows with null parent_message_id", () => {
    const messages: ConversationMessageRecord[] = [
      msg({
        id: "a1",
        role: "assistant",
        content: { text: "old turn" },
        created_at: "2026-01-01T00:00:01Z",
      }),
      msg({ id: "u1", role: "user", content: "next", created_at: "2026-01-01T00:00:05Z" }),
    ];
    // No parent_message_id — messages_v2 no longer guesses placement.
    const toolCalls: ConversationToolCallRecord[] = [
      call({ id: "c1", tool: "listSkills", created_at: "2026-01-01T00:00:02Z" }),
    ];
    const out = buildMessagesV2(messages, toolCalls);
    expect(out[0]?.parts.filter((p) => p.type === "tool_call")).toHaveLength(0);
  });

  test("ignores orphaned calls even when an anchored sibling exists", () => {
    const messages: ConversationMessageRecord[] = [
      msg({
        id: "a1",
        role: "assistant",
        content: { text: "mixed turn" },
        created_at: "2026-01-01T00:00:01Z",
      }),
    ];
    const toolCalls: ConversationToolCallRecord[] = [
      call({
        id: "c-anchored",
        tool: "listSkills",
        parent_message_id: "a1",
        created_at: "2026-01-01T00:00:02Z",
      }),
      // Legacy row with no anchor stays off messages_v2.
      call({ id: "c-legacy", tool: "searchKnowledge", created_at: "2026-01-01T00:00:03Z" }),
    ];
    const out = buildMessagesV2(messages, toolCalls);
    const ids = out[0]?.parts
      .filter((p) => p.type === "tool_call")
      .map((p) => (p as { call_id: string }).call_id);
    expect(ids).toEqual(["c-anchored"]);
  });
});

describe("buildMessagesV2", () => {
  test("keeps unanchored rows off user and assistant messages", () => {
    const messages: ConversationMessageRecord[] = [
      msg({ id: "u1", role: "user", content: "first", created_at: "2026-01-01T00:00:00Z" }),
      msg({
        id: "a1",
        role: "assistant",
        content: { text: "running a tool" },
        created_at: "2026-01-01T00:00:01Z",
      }),
    ];
    const toolCalls: ConversationToolCallRecord[] = [
      call({ id: "c1", tool: "listSkills", created_at: "2026-01-01T00:00:02Z" }),
    ];
    const out = buildMessagesV2(messages, toolCalls);
    expect(out).toHaveLength(2);
    expect(out[0]?.parts.filter((p) => p.type === "tool_call")).toHaveLength(0);
    expect(out[1]?.parts.filter((p) => p.type === "tool_call")).toHaveLength(0);
  });
});
