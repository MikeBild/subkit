import { expect, test } from "bun:test";
import type { ConversationDetail } from "@/api/client";
import { chatChoice } from "./chat-choice";

function fixture() {
  return {
    resume_summary: {
      pending_approval: {
        id: "request",
        tool_call_id: "call",
        tool_name: "ask_user_choice",
        expires_at: "2099-01-01T00:00:00Z",
      },
    },
    tool_calls: [
      {
        id: "call",
        tool: "ask_user_choice",
        input: {
          question: "How should I continue?",
          options: [
            { value: "preview", label: "Preview" },
            { value: "cancel", label: "Cancel" },
          ],
        },
      },
    ],
  } as unknown as ConversationDetail;
}
test("binds the choice to its exact pending call and preserves declared options", () => {
  expect(chatChoice(fixture())?.options.map((option) => option.value)).toEqual([
    "preview",
    "cancel",
  ]);
  expect(chatChoice(fixture())?.id).toBe("request");
});
test("does not guess another call or convert other question kinds", () => {
  for (const tool of ["ask_user_confirm", "ask_user_text", "ask_user_form"]) {
    const detail = fixture();
    detail.resume_summary!.pending_approval!.tool_name = tool;
    expect(chatChoice(detail)).toBeNull();
  }
  const detail = fixture();
  detail.tool_calls[0]!.id = "another";
  expect(chatChoice(detail)).toBeNull();
  expect(chatChoice(undefined)).toBeNull();
});
test("rejects malformed or ambiguous options", () => {
  for (const options of [
    [],
    [null, null],
    [
      { value: "same", label: "A" },
      { value: "same", label: "B" },
    ],
  ]) {
    const detail = fixture();
    detail.tool_calls[0]!.input = { question: "Choose", options };
    expect(chatChoice(detail)).toBeNull();
  }
});
