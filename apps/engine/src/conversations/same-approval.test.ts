import { describe, expect, test } from "bun:test";
import { FROZEN_NOW } from "../test-helpers/determinism/clock.ts";
import { saveVerificationEvidence } from "./handoff-summary.ts";
import { approvalHandleOf, asksForSameApproval, REUSABLE_APPROVAL_TOOLS } from "./same-approval.ts";
import type { DraftDocument } from "./types.ts";

const now = new Date(FROZEN_NOW);
const later = new Date(FROZEN_NOW + 60_000);
const verification = (name = "orders") =>
  saveVerificationEvidence({ workflow: { name } } as DraftDocument, true);

const agentSaveCard = (overrides: Record<string, unknown> = {}) => ({
  tool_name: "ask_user_confirm",
  expires_at: later,
  input: {
    kind: "save_workflow_draft",
    question: "Commit this workflow?",
    verification: verification(),
    commit_intent: { kind: "save_workflow_draft", payload: {}, description: "commit" },
    ...overrides,
  },
});

const saveGate = (
  args: Record<string, unknown> = { force_commit: false, confirmed: false },
  overrides: Record<string, unknown> = {},
  handle = "00000000-0000-4000-8000-000000000001",
) => ({
  tool_name: "ask_user_confirm",
  input: {
    kind: "save_workflow_draft",
    question: "Policy requires confirmation before running save_workflow_draft. Proceed?",
    target: { tool: "save_workflow_draft", args },
    verification: verification(),
    pending_output: { kind: "save_workflow_draft" },
    commit_intent: {
      kind: "save_workflow_draft",
      payload: {
        ...(typeof args.target_workflow_id === "string"
          ? { target_workflow_id: args.target_workflow_id }
          : {}),
        ...(args.force_commit === true ? { force_commit: true } : {}),
        approval_id: handle,
      },
      description: "Save the current workflow draft.",
    },
    ...overrides,
  },
});

const asOpen = (request: { tool_name: string; input: unknown }, expires_at = later) => ({
  ...request,
  expires_at,
});

describe("conversations/same-approval", () => {
  test("only draft saves are allowlisted for reuse", () => {
    expect([...REUSABLE_APPROVAL_TOOLS]).toEqual(["save_workflow_draft"]);
  });

  test("a save gate reuses the open save card for the same draft", () => {
    expect(asksForSameApproval(agentSaveCard(), saveGate(), now)).toBe(true);
    expect(asksForSameApproval(asOpen(saveGate()), saveGate(), now)).toBe(true);
  });

  test("an expired card is never reused", () => {
    expect(asksForSameApproval(asOpen(saveGate(), now), saveGate(), now)).toBe(false);
    expect(asksForSameApproval({ ...agentSaveCard(), expires_at: now }, saveGate(), now)).toBe(
      false,
    );
  });

  test("a changed draft, verification or effect needs a new card", () => {
    const changedDraft = saveGate(undefined, { verification: verification("invoices") });
    expect(asksForSameApproval(agentSaveCard(), changedDraft, now)).toBe(false);
    const changedPreview = saveGate(undefined, {
      verification: { ...verification(), preview: "failed" },
    });
    expect(asksForSameApproval(agentSaveCard(), changedPreview, now)).toBe(false);
    const unbound = saveGate(undefined, { verification: { preview: "passed" } });
    expect(asksForSameApproval(asOpen(unbound), unbound, now)).toBe(false);
    const withEffect = saveGate(undefined, { effect: { summary: "writes" } });
    expect(asksForSameApproval(agentSaveCard(), withEffect, now)).toBe(false);
    expect(asksForSameApproval(asOpen(withEffect), withEffect, now)).toBe(true);
  });

  test("changed save arguments need a new card", () => {
    const open = asOpen(saveGate());
    for (const args of [
      { force_commit: true, confirmed: false },
      { force_commit: false, confirmed: true },
      { force_commit: false, confirmed: false, target_workflow_id: "wf-1" },
      { force_commit: false, confirmed: false, expected_draft_version_id: null, extra: 1 },
      {
        force_commit: false,
        confirmed: false,
        expected_draft_version_id: "00000000-0000-4000-8000-0000000000aa",
      },
    ])
      expect(asksForSameApproval(open, saveGate(args), now)).toBe(false);
    expect(asksForSameApproval(agentSaveCard(), saveGate({ force_commit: true }), now)).toBe(false);
    const pinned = agentSaveCard({
      commit_intent: { kind: "save_workflow_draft", payload: { target_workflow_id: "wf-1" } },
    });
    expect(asksForSameApproval(pinned, saveGate(), now)).toBe(false);
    expect(asksForSameApproval(pinned, saveGate({ target_workflow_id: "wf-1" }), now)).toBe(true);
  });

  test("a card whose arguments disagree with its commit intent is never reused", () => {
    const inconsistent = saveGate(
      { force_commit: true },
      {
        commit_intent: { kind: "save_workflow_draft", payload: {} },
      },
    );
    expect(asksForSameApproval(asOpen(inconsistent), inconsistent, now)).toBe(false);
  });

  test("only a save gate request reuses a card; ask-user cards never do", () => {
    expect(asksForSameApproval(agentSaveCard(), agentSaveCard(), now)).toBe(false);
    expect(asksForSameApproval(asOpen(saveGate()), agentSaveCard(), now)).toBe(false);
  });

  test("external MCP tool approvals are never reused, even for identical arguments", () => {
    const mcpCard = (args: Record<string, unknown>, handle: string) => ({
      tool_name: "ask_user_confirm",
      input: {
        kind: "external_write",
        target: { tool: "mcp__crm__update_contact", server: "crm", args },
        commit_intent: {
          kind: "execute_confirmed_tool_call",
          payload: { tool: "mcp__crm__update_contact", approval_id: handle },
        },
      },
    });
    const first = mcpCard({ id: "1" }, "00000000-0000-4000-8000-000000000011");
    const sameArgs = mcpCard({ id: "1" }, "00000000-0000-4000-8000-000000000012");
    const otherArgs = mcpCard({ id: "2" }, "00000000-0000-4000-8000-000000000013");
    expect(asksForSameApproval(asOpen(first), sameArgs, now)).toBe(false);
    expect(asksForSameApproval(asOpen(first), otherArgs, now)).toBe(false);
    const relayed = (handle: string) => ({
      tool_name: "ask_user_confirm",
      input: {
        kind: "external_write",
        target: { tool: "mcp_publish", connector_slug: "publisher", remote_tool: "publish" },
        pending_output: { input_keys: ["body"] },
        commit_intent: {
          kind: "grant_relayed_tool_call",
          payload: { tool: "mcp_publish", approval_id: handle },
        },
      },
    });
    expect(asksForSameApproval(asOpen(relayed("original")), relayed("original"), now)).toBe(false);
    expect(asksForSameApproval(asOpen(relayed("original")), relayed("new"), now)).toBe(false);
  });

  test("workflow input forms never reuse a card", () => {
    const intent = { kind: "run_workflow", payload: { workflow: "publish", environment: "dev" } };
    const card = { tool_name: "ask_user_confirm", input: { commit_intent: intent } };
    const form = {
      tool_name: "ask_user_form",
      input: { commit_intent: intent, fields: [{ name: "date", type: "text", required: true }] },
    };
    expect(asksForSameApproval(asOpen(card), form, now)).toBe(false);
    expect(asksForSameApproval(asOpen(form), card, now)).toBe(false);
    expect(asksForSameApproval(asOpen(form), form, now)).toBe(false);
  });

  test("other tools and typed questions are never reused", () => {
    const runGate = {
      tool_name: "ask_user_confirm",
      input: { kind: "external_write", target: { tool: "run_workflow", args: { workflow: "a" } } },
    };
    expect(asksForSameApproval(asOpen(runGate), runGate, now)).toBe(false);
    const typed = { tool_name: "ask_user_confirm", input: { question: "Continue?" } };
    expect(asksForSameApproval(asOpen(typed), saveGate(), now)).toBe(false);
    const form = { ...saveGate(), tool_name: "ask_user_form" };
    expect(asksForSameApproval(asOpen(form), form, now)).toBe(false);
  });

  test("a card that opens an authorization link is never reused", () => {
    const linked = saveGate(undefined, { authorization_url: "https://idp.test/auth" });
    expect(asksForSameApproval(asOpen(linked), linked, now)).toBe(false);
  });

  test("reads the approval handle from the commit intent", () => {
    expect(approvalHandleOf(saveGate().input)).toBe("00000000-0000-4000-8000-000000000001");
    expect(approvalHandleOf(agentSaveCard().input)).toBeNull();
  });
});
