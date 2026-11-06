import { afterEach, describe, expect, mock, test } from "bun:test";
import { ElicitRouter } from "@chat-ui/index.ts";
import { cleanup, render } from "ink-testing-library";
import type { ConversationDetail } from "../engine-client.ts";
import { hydrateConversation, pendingElicitationInput } from "../ink-app/hydrate-conversation.ts";

afterEach(() => cleanup());

type Pending = NonNullable<NonNullable<ConversationDetail["resume_summary"]>["pending_approval"]>;
type ToolCall = ConversationDetail["tool_calls"][number];

const STAMP = "2026-11-06T08:00:00.000Z";

function toolCall(input: unknown): ToolCall {
  return {
    id: "call-1",
    conversation_id: "conv-1",
    tool: "ask_user_confirm",
    input,
    output: null,
    approval_required: true,
    created_at: STAMP,
    parent_message_id: null,
    confirmation_state: null,
    approved_at: null,
    outcome: "pending",
  };
}

function pending(prompt: Pending["prompt"]): Pending {
  return {
    id: "elicit-1",
    tool_call_id: "call-1",
    tool_name: "ask_user_confirm",
    summary: "Keep these edits?",
    ...(prompt ? { prompt } : {}),
    expires_at: STAMP,
  };
}

const diffs = [
  { label: "replace /steps/0/expression", preview: "return { a };" },
  { label: "replace /steps/1/expression", preview: "return { b };" },
];

describe("pendingElicitationInput", () => {
  test("a resumed partial approval carries the asked kind, its diffs and the commit intent", () => {
    const input = pendingElicitationInput(
      pending({ question: "Keep these edits?", intent_kind: "apply_workflow_patch" }),
      [
        toolCall({
          question: "Keep these edits?",
          kind: "partial_diff_approval",
          diffs,
          commit_intent: { kind: "apply_workflow_patch", payload: { patches: [{}, {}] } },
        }),
      ],
    );
    expect(input).toEqual({
      question: "Keep these edits?",
      kind: "partial_diff_approval",
      diffs,
      commit_intent: { kind: "apply_workflow_patch", payload: { patches: [{}, {}] } },
    });
    expect(input).not.toHaveProperty("intent_kind");
  });

  test("the prompt wins over the stored call and names the intent without a stored call", () => {
    expect(
      pendingElicitationInput(
        pending({ question: "Save the draft now?", intent_kind: "save_workflow_draft" }),
        [toolCall({ question: "Save?", kind: "save_workflow_draft" })],
      ),
    ).toEqual({
      question: "Save the draft now?",
      kind: "save_workflow_draft",
      commit_intent: { kind: "save_workflow_draft" },
    });
    expect(
      pendingElicitationInput(pending({ question: "Run it?", intent_kind: "run_workflow" }), []),
    ).toEqual({ question: "Run it?", commit_intent: { kind: "run_workflow" } });
  });

  test("a call of another tool or a non-object input adds nothing", () => {
    const other = { ...toolCall({ kind: "external_write" }), tool: "save_workflow_draft" };
    expect(pendingElicitationInput(pending({ question: "Go?" }), [other])).toEqual({
      question: "Go?",
    });
    expect(pendingElicitationInput(pending({ question: "Go?" }), [toolCall(["x"])])).toEqual({
      question: "Go?",
    });
    expect(pendingElicitationInput(pending(undefined), [])).toEqual({
      question: "Keep these edits?",
    });
  });
});

describe("hydrateConversation", () => {
  test("a resumed partial approval renders its diffs", () => {
    const detail = {
      conversation: { id: "conv-1", status: "awaiting_input" },
      messages: [],
      tool_calls: [
        toolCall({ question: "Keep these edits?", kind: "partial_diff_approval", diffs }),
      ],
      resume_summary: {
        pending_approval: pending({
          question: "Keep these edits?",
          intent_kind: "apply_workflow_patch",
        }),
      },
    } as unknown as ConversationDetail;
    const elicitation = hydrateConversation(detail).pendingElicitation;
    if (!elicitation) throw new Error("no pending elicitation");
    const frame =
      render(<ElicitRouter elicitation={elicitation} onResponse={mock()} />).lastFrame() ?? "";
    expect(frame).toContain("replace /steps/0/expression");
    expect(frame).toContain("replace /steps/1/expression");
  });
});
