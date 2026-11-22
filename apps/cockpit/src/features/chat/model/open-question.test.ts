import { describe, expect, test } from "bun:test";
import { typedReply } from "@shared/typed-reply.ts";
import type { ConversationDetail } from "@/api/client";
import { openQuestionOf } from "./open-question";

const NOW = Date.parse("2026-11-22T10:00:00Z");
const options = [
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
];

function detail(
  tool_name: string,
  expires_at = "2026-11-22T11:00:00Z",
  input: Record<string, unknown> = { question: "When?", options },
) {
  return {
    resume_summary: {
      pending_approval: { id: "question", tool_call_id: "call", tool_name, expires_at },
    },
    tool_calls: [{ id: "call", tool: tool_name, input }],
  } as unknown as ConversationDetail;
}

describe("the question the composer answers", () => {
  test("carries the asked options, so a typed option answers the choice", () => {
    const question = openQuestionOf(detail("ask_user_choice"), NOW);
    expect(question).toEqual({
      id: "question",
      tool_name: "ask_user_choice",
      input: { question: "When?", options },
    });
    expect(question && typedReply(question, "tomorrow")).toEqual({
      kind: "answer",
      output: { value: "tomorrow" },
    });
  });

  test("a plain confirmation is answered by a clear yes and stays open for anything else", () => {
    const question = openQuestionOf(
      detail("ask_user_confirm", undefined, { question: "Use the shorter title?" }),
      NOW,
    );
    expect(question && typedReply(question, "ja")).toEqual({
      kind: "answer",
      output: { confirmed: true },
    });
    expect(question && typedReply(question, "Wer bekommt die Mail?")).toEqual({
      kind: "message",
    });
  });

  test("a confirmation that releases a write keeps a typed yes as a message", () => {
    const question = openQuestionOf(
      detail("ask_user_confirm", undefined, {
        question: "Send it?",
        commit_intent: { kind: "execute_confirmed_tool_call" },
      }),
      NOW,
    );
    expect(question && typedReply(question, "ja")).toEqual({ kind: "message" });
  });

  test("an expired or missing question is no question", () => {
    expect(openQuestionOf(detail("ask_user_confirm", "2026-11-22T09:00:00Z"), NOW)).toBeNull();
    expect(
      openQuestionOf({ resume_summary: null, tool_calls: [] } as unknown as ConversationDetail),
    ).toBeNull();
  });
});
