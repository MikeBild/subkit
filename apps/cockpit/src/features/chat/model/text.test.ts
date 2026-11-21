import { expect, test } from "bun:test";
import type { ConversationDetail } from "@/api/client";
import { chatText, composerAnswerAccepted, questionExcerpt, textAnswerAcceptable } from "./text";

function fixture(): ConversationDetail {
  return {
    resume_summary: {
      pending_approval: {
        id: "request",
        tool_call_id: "call",
        tool_name: "ask_user_text",
        summary: "",
        prompt: { question: "Wie soll dein Workflow heißen?" },
        expires_at: "2099-01-01T00:00:00Z",
      },
    },
    tool_calls: [
      {
        id: "call",
        tool: "ask_user_text",
        input: {
          question: "Wie soll dein Workflow heißen?",
          placeholder: "Example API Data Fetch",
          default: "Tagesbericht",
          validation_regex: "^[A-Za-z ]+$",
        },
      },
    ],
  } as unknown as ConversationDetail;
}

test("reads the question from the prompt and the input extras from the call", () => {
  expect(chatText(fixture())).toEqual({
    id: "request",
    toolCallId: "call",
    question: "Wie soll dein Workflow heißen?",
    placeholder: "Example API Data Fetch",
    initialValue: "Tagesbericht",
    multiline: false,
    pattern: "^[A-Za-z ]+$",
    expiresAt: "2099-01-01T00:00:00Z",
  });
});

test("a question the harness parked from prose has no call and still shows", () => {
  const detail = fixture();
  detail.resume_summary!.pending_approval!.tool_call_id = null;
  detail.resume_summary!.pending_approval!.summary = "the assistant asked a question";
  detail.resume_summary!.pending_approval!.prompt = { question: "Welcher Endpoint?" };
  detail.tool_calls = [];
  const text = chatText(detail);
  expect(text?.toolCallId).toBeNull();
  expect(text?.question).toBe("Welcher Endpoint?");
  expect(text?.placeholder).toBeUndefined();
});

test("never reads the question from the summary", () => {
  const detail = fixture();
  detail.resume_summary!.pending_approval!.prompt = undefined;
  detail.resume_summary!.pending_approval!.summary = "Something else";
  detail.tool_calls = [];
  expect(chatText(detail)).toBeNull();
});

test("other question kinds are not text questions", () => {
  for (const tool of ["ask_user_confirm", "ask_user_choice", "ask_user_form"]) {
    const detail = fixture();
    detail.resume_summary!.pending_approval!.tool_name = tool;
    expect(chatText(detail)).toBeNull();
  }
});

test("an answer is empty or rejected by its declared pattern", () => {
  expect(textAnswerAcceptable({}, "  ")).toBe(false);
  expect(textAnswerAcceptable({}, "anything")).toBe(true);
  expect(textAnswerAcceptable({ pattern: "^[0-9]+$" }, "12")).toBe(true);
  expect(textAnswerAcceptable({ pattern: "^[0-9]+$" }, "zwölf")).toBe(false);
  expect(textAnswerAcceptable({ pattern: "(" }, "x")).toBe(true);
});

test("the composer takes any message when no text question waits", () => {
  expect(composerAnswerAccepted(null, "zwölf")).toBe(true);
});

test("the composer holds back an answer the waiting question would reject", () => {
  const text = chatText(fixture())!;
  expect(composerAnswerAccepted(text, "Tagesbericht Kunden")).toBe(true);
  expect(composerAnswerAccepted(text, "Bericht 2")).toBe(false);
  expect(composerAnswerAccepted(text, "   ")).toBe(false);
  expect(composerAnswerAccepted({ ...text, pattern: undefined }, "Bericht 2")).toBe(true);
});

test("the composer hint names a long question in one short line", () => {
  expect(questionExcerpt("Wie\nheißt   er?")).toBe("Wie heißt er?");
  const long = questionExcerpt("a".repeat(300));
  expect(long.length).toBe(120);
  expect(long.endsWith("…")).toBe(true);
});
