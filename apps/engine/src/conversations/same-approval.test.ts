import { describe, expect, test } from "bun:test";
import { saveVerificationEvidence } from "./handoff-summary.ts";
import { approvalAction, asksForSameApproval } from "./same-approval.ts";
import type { DraftDocument } from "./types.ts";

const saveCard = {
  tool_name: "ask_user_confirm",
  input: {
    question: "Commit this workflow?",
    kind: "save_workflow_draft",
    commit_intent: { kind: "save_workflow_draft", payload: {} },
  },
};
const saveGate = {
  tool_name: "ask_user_confirm",
  input: {
    kind: "save_workflow_draft",
    question: "Save the draft?",
    target: { tool: "save_workflow_draft", args: { confirmed: false } },
    commit_intent: { kind: "save_workflow_draft", payload: { approval_id: "handle-1" } },
  },
};
const runGate = (workflow: string) => ({
  tool_name: "ask_user_confirm",
  input: { kind: "external_write", target: { tool: "run_workflow", args: { workflow } } },
});
const oauthCard = (connector_id: string, extra: Record<string, unknown> = {}) => ({
  tool_name: "ask_user_confirm",
  input: {
    kind: "external_write",
    commit_intent: { kind: "oauth_completed", payload: { connector_id } },
    ...extra,
  },
});

describe("conversations/same-approval", () => {
  test("workflow input forms cannot reuse approval cards or other input forms", () => {
    const input = {
      commit_intent: {
        kind: "run_workflow",
        payload: { workflow: "publish", environment: "dev" },
      },
    };
    const card = { tool_name: "ask_user_confirm", input };
    const form = {
      tool_name: "ask_user_form",
      input: {
        ...input,
        fields: [{ name: "date", type: "text", required: true }],
      },
    };
    expect(asksForSameApproval(card, form)).toBe(false);
    expect(asksForSameApproval(form, card)).toBe(false);
    expect(asksForSameApproval(form, form)).toBe(false);
    expect(
      asksForSameApproval(form, {
        ...form,
        input: { ...input, fields: [{ name: "filename", type: "text", required: true }] },
      }),
    ).toBe(false);
  });

  test("names the action from the target, the commit intent or a specific kind", () => {
    expect(approvalAction(saveGate.input)).toEqual({
      name: "save_workflow_draft",
      targetArgs: { confirmed: false },
      intent: { kind: "save_workflow_draft", payload: {} },
    });
    expect(
      approvalAction({
        commit_intent: { kind: "execute_confirmed_tool_call", payload: { tool: "x" } },
      })?.name,
    ).toBe("x");
    expect(approvalAction({ kind: "save_workflow_draft" })).toEqual({
      name: "save_workflow_draft",
    });
    expect(approvalAction({ kind: "external_write" })).toBeNull();
    expect(approvalAction({ question: "Continue?" })).toBeNull();
  });

  test("an open save card and a save gate ask for the same approval", () => {
    expect(asksForSameApproval(saveCard, saveGate)).toBe(true);
    expect(asksForSameApproval(saveGate, saveGate)).toBe(true);
  });

  test("save approval reuse is bound to the draft even with identical arguments and preview", () => {
    const card = (name: string) => ({
      ...saveGate,
      input: {
        ...saveGate.input,
        verification: saveVerificationEvidence({ workflow: { name } } as DraftDocument, true),
      },
    });
    expect(asksForSameApproval(card("first"), card("first"))).toBe(true);
    expect(asksForSameApproval(card("first"), card("second"))).toBe(false);
  });

  test("connector saves without a draft binding require a new approval", () => {
    const card = (question: string) => ({
      tool_name: "ask_user_confirm",
      input: {
        question,
        kind: "save_connector_draft",
        commit_intent: { kind: "save_connector_draft", payload: {} },
      },
    });
    const open = card("Save the connector for https://first.test?");
    const next = card("Save the connector for https://second.test?");
    expect(asksForSameApproval(open, next)).toBe(false);
    expect(
      asksForSameApproval(open, {
        tool_name: "ask_user_confirm",
        input: {
          kind: "external_write",
          target: { tool: "save_connector_draft", args: {} },
        },
      }),
    ).toBe(false);
  });

  test("changed or missing verification and effects require a new approval", () => {
    for (const field of ["verification", "effect"] as const) {
      const card = (value?: string) => ({
        ...saveGate,
        input: { ...saveGate.input, ...(value ? { [field]: { summary: value } } : {}) },
      });
      expect(asksForSameApproval(card("first"), card("first"))).toBe(true);
      expect(asksForSameApproval(card("first"), card("second"))).toBe(false);
      expect(asksForSameApproval(card("first"), card())).toBe(false);
      expect(asksForSameApproval(card(), card("first"))).toBe(false);
    }
  });

  test("a different action or different arguments is not the same approval", () => {
    expect(asksForSameApproval(saveCard, runGate("a"))).toBe(false);
    expect(asksForSameApproval(runGate("a"), runGate("b"))).toBe(false);
    expect(asksForSameApproval(runGate("a"), runGate("a"))).toBe(true);
    expect(asksForSameApproval(oauthCard("a"), oauthCard("b"))).toBe(false);
  });

  test("external MCP confirmations stay bound to the advertised approval handle", () => {
    const card = (approvalId: string) => ({
      tool_name: "ask_user_confirm",
      input: {
        kind: "external_write",
        target: { tool: "mcp_publish", connector_slug: "publisher", remote_tool: "publish" },
        pending_output: { input_keys: ["body"] },
        commit_intent: {
          kind: "grant_relayed_tool_call",
          payload: { tool: "mcp_publish", approval_id: approvalId },
        },
      },
    });
    expect(asksForSameApproval(card("original"), card("new-arguments"))).toBe(false);
    expect(asksForSameApproval(card("original"), card("same-arguments-new-handle"))).toBe(false);
    expect(asksForSameApproval(card("original"), card("original"))).toBe(true);
  });

  test("held workflow writes keep approval bound to their preview", () => {
    const heldCard = (approvalId: string, workflowSlug = "publish", value = "first") => ({
      tool_name: "ask_user_confirm",
      input: {
        kind: "external_write",
        target: { tool: "run_workflow", workflow_slug: workflowSlug },
        pending_output: {
          held_steps: ["write"],
          would_write: [{ body: value }],
        },
        commit_intent: {
          kind: "commit_held_workflow_writes",
          payload: { tool: "run_workflow", approval_id: approvalId },
        },
      },
    });
    const open = heldCard("preview-1");
    expect(asksForSameApproval(open, heldCard("preview-2", "publish", "changed"))).toBe(false);
    expect(asksForSameApproval(open, heldCard("preview-3", "another"))).toBe(false);
    expect(asksForSameApproval(open, heldCard("preview-4"))).toBe(false);
    expect(asksForSameApproval(open, heldCard("preview-1"))).toBe(true);
  });

  test("a card that opens an authorization link is never reused", () => {
    const link = { authorization_url: "https://idp.test/auth" };
    expect(asksForSameApproval(oauthCard("a", link), oauthCard("a", link))).toBe(false);
  });

  test("local confirmations remain bound to their own tool call", () => {
    const localCard = (command_id: string | null) => ({
      tool_name: "ask_user_confirm",
      input: {
        kind: "local_confirmation",
        target: { tool: "device_command", args: { command: "open" } },
        device: {
          device_id: "device-1",
          capability: "browser",
          target: "Open example.test",
          command_id,
          binding_hash: null,
          deadline_at: "2026-11-25T12:00:00.000Z",
        },
      },
    });
    expect(asksForSameApproval(localCard("command-1"), localCard("command-2"))).toBe(false);
    expect(asksForSameApproval(localCard(null), localCard(null))).toBe(false);
    expect(asksForSameApproval(localCard("command-1"), localCard("command-1"))).toBe(false);
    expect(
      asksForSameApproval(localCard("command-1"), {
        tool_name: "ask_user_confirm",
        input: { kind: "external_write", target: localCard("command-1").input.target },
      }),
    ).toBe(false);
    expect(
      asksForSameApproval(
        {
          tool_name: "ask_user_confirm",
          input: { kind: "external_write", target: localCard("command-1").input.target },
        },
        localCard("command-1"),
      ),
    ).toBe(false);
  });

  test("a typed question is never treated as the same approval", () => {
    const typed = { tool_name: "ask_user_confirm", input: { question: "Continue?" } };
    expect(asksForSameApproval(typed, typed)).toBe(false);
    expect(asksForSameApproval(typed, saveGate)).toBe(false);
  });
});
