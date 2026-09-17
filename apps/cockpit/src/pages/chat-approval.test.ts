import { expect, test } from "bun:test";
import type { ConversationDetail } from "@/api/client";
import { chatApproval } from "./chat-approval";

function fixture(tool = "ask_user_confirm", callId: string | null = "call-1") {
  return {
    resume_summary: {
      pending_approval: {
        id: "elicitation-2",
        tool_call_id: callId,
        tool_name: tool,
        expires_at: "2099-01-01T00:00:00Z",
      },
    },
    tool_calls: [
      {
        id: "call-1",
        tool: "ask_user_confirm",
        input: {
          question: "Save the inactive version?",
          commit_intent: { kind: "save_workflow_draft", description: "Save the changed schedule." },
        },
      },
    ],
  } as unknown as ConversationDetail;
}
test("binds distinct request and tool ids and describes the inactive save", () => {
  expect(chatApproval(fixture())).toEqual({
    id: "elicitation-2",
    toolCallId: "call-1",
    question: "Save the inactive version?",
    description: "Save the changed schedule.",
    savesInactiveWorkflow: true,
    expiresAt: "2099-01-01T00:00:00Z",
  });
});
test("never guesses a tool call or turns text/form questions into grants", () => {
  for (const detail of [
    undefined,
    fixture("ask_user_text"),
    fixture("ask_user_form"),
    fixture("ask_user_confirm", null),
    fixture("ask_user_confirm", "unrelated"),
  ])
    expect(chatApproval(detail)).toBeNull();
});
test("requires a readable question and does not label other decisions as inactive saves", () => {
  const detail = fixture();
  detail.tool_calls[0]!.input = { question: "Continue?" };
  expect(chatApproval(detail)?.savesInactiveWorkflow).toBe(false);
  detail.tool_calls[0]!.input = { question: "  " };
  expect(chatApproval(detail)).toBeNull();
});

test("renders a policy confirmation attached to the actual OAuth tool", () => {
  const detail = fixture();
  detail.tool_calls[0]!.tool = "authenticate_oauth";
  detail.tool_calls[0]!.input = { connector_id: "connection-1" };
  detail.resume_summary!.pending_approval!.prompt = {
    question: "Policy requires confirmation before running authenticate_oauth. Proceed?",
    intent_kind: "execute_tool",
  };
  expect(chatApproval(detail)).toMatchObject({
    id: "elicitation-2",
    toolCallId: "call-1",
    oauth: "start",
  });
  detail.resume_summary!.pending_approval!.prompt = {
    question: "Have you completed the authorization?",
    intent_kind: "oauth_completed",
    authorization_url: "https://provider.example/authorize?state=fixture",
  };
  expect(chatApproval(detail)).toMatchObject({
    oauth: "complete",
    authorizationUrl: "https://provider.example/authorize?state=fixture",
  });
  detail.resume_summary!.pending_approval!.tool_call_id = "different-call";
  expect(chatApproval(detail)).toBeNull();
});

test("held writes use a native single-run decision bound to the original pending call", () => {
  const detail = fixture();
  detail.tool_calls[0]!.tool = "wf_daily_report";
  detail.resume_summary!.pending_approval!.prompt = {
    question: "Perform held writes?",
    intent_kind: "commit_held_workflow_writes",
  };
  expect(chatApproval(detail)).toMatchObject({
    singleRun: true,
    toolCallId: "call-1",
    id: "elicitation-2",
    savesInactiveWorkflow: false,
  });
});

test("a single-run intent cannot be presented as recurring permission by model wording", () => {
  const detail = fixture();
  detail.tool_calls[0]!.input = {
    question: "Approve recurring delivery?",
    commit_intent: {
      kind: "run_workflow",
      payload: { execute_writes: true },
      description: "Authorize recurring delivery",
    },
  };
  expect(chatApproval(detail)).toMatchObject({ singleRun: true, savesInactiveWorkflow: false });
});
