import { expect, test } from "bun:test";
import type { ConversationDetail } from "@/api/client";
import { type TranslationKey, translate } from "@/lib/i18n";
import {
  approvalLine,
  type ChatApproval,
  chatApproval,
  conversationRefreshInterval,
  OPEN_QUESTION_REFRESH_MS,
  pendingApprovalSubject,
  recordedDecisionKey,
  waitsForPerson,
  withWorkflowName,
} from "./chat-approval";

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

test("an external MCP tool approval is phrased from the connector and tool, not the engine's prose", () => {
  const detail = fixture();
  detail.tool_calls[0]!.tool = "mcp_metabase-reporting-mcp__search";
  detail.tool_calls[0]!.input = { q: "revenue" };
  detail.resume_summary!.pending_approval!.prompt = {
    question: 'Run the tool "search" on Metabase Reporting MCP?',
    intent_kind: "grant_relayed_tool_call",
    external_tool: {
      connector: "Metabase Reporting MCP",
      tool: "search",
      server_claim: "Search saved questions and dashboards",
    },
  };
  expect(chatApproval(detail)).toMatchObject({
    externalTool: {
      connector: "Metabase Reporting MCP",
      tool: "search",
      server_claim: "Search saved questions and dashboards",
    },
    description: null,
  });
  detail.resume_summary!.pending_approval!.prompt!.intent_kind = "execute_confirmed_tool_call";
  expect(chatApproval(detail)?.externalTool).toBeUndefined();
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

function gatedConnectorCall() {
  const detail = fixture();
  detail.tool_calls[0]!.tool = "call_connector";
  detail.tool_calls[0]!.input = { connector_id: "connector-1", method: "PATCH", path: "/v1/x" };
  detail.resume_summary!.pending_approval!.prompt = {
    question: "Reporting API: PATCH https://api.example/v1/x — approve this call?",
    intent_kind: "execute_confirmed_tool_call",
    effect: { connector: "Reporting API", method: "PATCH", target: "https://api.example/v1/x" },
  };
  return detail;
}

test("a policy-gated connector call is described by its effect, not by the engine's sentence", () => {
  expect(chatApproval(gatedConnectorCall())).toMatchObject({
    connectorCall: {
      connector: "Reporting API",
      method: "PATCH",
      target: "https://api.example/v1/x",
    },
    description: null,
  });
  const generic = gatedConnectorCall();
  delete generic.resume_summary!.pending_approval!.prompt!.effect;
  expect(chatApproval(generic)).toMatchObject({ gatedTool: "call_connector", description: null });
});

test("once the server records the decision, no decision card remains and nobody is waited for", () => {
  const decided = gatedConnectorCall();
  decided.resume_summary!.pending_approval = null;
  decided.tool_calls = [
    {
      ...decided.tool_calls[0]!,
      confirmation_state: "confirmed",
      outcome: "ok",
      output: { status: "resolved", elicitation_id: "elicitation-2" },
    },
    {
      id: "call-2",
      tool: "call_connector",
      input: { _harness_auto_persist: true },
      parent_message_id: null,
      confirmation_state: "declined",
      outcome: "error",
      output: { ok: false, source: "harness_auto_persist" },
    },
  ] as unknown as ConversationDetail["tool_calls"];
  const approval = chatApproval(decided);
  expect(approval).toBeNull();
  expect(conversationRefreshInterval(decided)).toBe(false);
  expect(
    waitsForPerson({
      questions: [approval],
      now: Date.parse("2030-01-01T00:00:00Z"),
      pendingApproval: decided.resume_summary!.pending_approval,
      detailLoaded: true,
      rowOutcome: "awaiting_you",
    }),
  ).toBe(false);
  expect(
    waitsForPerson({
      questions: [],
      now: Date.parse("2030-01-01T00:00:00Z"),
      pendingApproval: null,
      detailLoaded: false,
      rowOutcome: "awaiting_you",
    }),
  ).toBe(true);
});

test("a queued or running live test keeps its result fresh until completion", () => {
  const detail = gatedConnectorCall();
  detail.resume_summary!.pending_approval = null;
  for (const status of ["queued", "running", "succeeded", "failed", "cancelled"]) {
    detail.resume_summary!.live_test = { execution_id: "execution", status };
    expect(conversationRefreshInterval(detail)).toBe(
      status === "queued" || status === "running" ? OPEN_QUESTION_REFRESH_MS : false,
    );
  }
});

test("an open decision keeps the conversation fresh so a decision made elsewhere shows up", () => {
  const open = gatedConnectorCall();
  expect(conversationRefreshInterval(open)).toBe(OPEN_QUESTION_REFRESH_MS);
  expect(
    waitsForPerson({
      questions: [chatApproval(open)],
      now: Date.parse("2030-01-01T00:00:00Z"),
      pendingApproval: open.resume_summary!.pending_approval,
      detailLoaded: true,
      rowOutcome: "awaiting_you",
    }),
  ).toBe(true);
  expect(
    waitsForPerson({
      questions: [chatApproval(open)],
      now: Date.parse("2100-01-01T00:00:00Z"),
      pendingApproval: open.resume_summary!.pending_approval,
      detailLoaded: true,
      rowOutcome: "awaiting_you",
    }),
  ).toBe(false);
});

test("a recorded decision reads as the reader's verdict, never as the engine's marker", () => {
  expect(
    recordedDecisionKey({
      type: "text",
      text: "✓ Approved: call_connector",
      decision: { state: "confirmed", tool: "call_connector" },
    }),
  ).toBe("tool.outcome.approved");
  expect(recordedDecisionKey({ type: "text", decision: { state: "declined", tool: null } })).toBe(
    "tool.outcome.declined",
  );
  expect(recordedDecisionKey({ type: "text", text: "✓ Approved: call_connector" })).toBeNull();
});

test("an open approval in the context panel reads in the viewer's language, not the engine's", () => {
  const de = (key: TranslationKey, values?: Record<string, string>) => translate("de", key, values);
  const same = (value: string) => value;
  const call = pendingApprovalSubject(
    {
      id: "elicitation-3",
      tool_name: "call_connector",
      summary: "Orders API: POST https://orders.example.test/orders",
      expires_at: "2099-01-01T00:00:00Z",
      prompt: {
        question: "Orders API: POST https://orders.example.test/orders — approve this call?",
        intent_kind: "execute_confirmed_tool_call",
        effect: {
          connector: "Orders API",
          method: "POST",
          target: "https://orders.example.test/orders",
        },
      },
    },
    null,
  );
  expect(approvalLine(call, de, same)).toBe(
    "Orders API aufrufen: POST https://orders.example.test/orders",
  );
  const gated = pendingApprovalSubject(
    {
      id: "elicitation-4",
      tool_name: "delete_workflow",
      summary: "Confirm delete_workflow (policy: confirm_before_execution)",
      expires_at: "2099-01-01T00:00:00Z",
      prompt: {
        question: "Policy requires confirmation before running delete_workflow. Proceed?",
        intent_kind: "execute_confirmed_tool_call",
      },
    },
    null,
  );
  expect(approvalLine(gated, de, same)).toBe(translate("de", "chat.decision.gatedAction"));
});

test("the card names the requested workflow, not the conversation target", () => {
  const approval = { workflowName: "Anderer Ablauf", workflowSlug: "support-send" } as ChatApproval;
  expect(withWorkflowName(approval, () => "Support-Anfrage senden").workflowName).toBe(
    "Support-Anfrage senden",
  );
  expect(withWorkflowName(approval, () => null).workflowName).toBe("Anderer Ablauf");
});
