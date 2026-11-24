import { describe, expect, test } from "bun:test";
import { approvalAction, asksForSameApproval } from "./same-approval.ts";

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

  test("a different action or different arguments is not the same approval", () => {
    expect(asksForSameApproval(saveCard, runGate("a"))).toBe(false);
    expect(asksForSameApproval(runGate("a"), runGate("b"))).toBe(false);
    expect(asksForSameApproval(runGate("a"), runGate("a"))).toBe(true);
    expect(asksForSameApproval(oauthCard("a"), oauthCard("b"))).toBe(false);
  });

  test("a card that opens an authorization link is never reused", () => {
    const link = { authorization_url: "https://idp.test/auth" };
    expect(asksForSameApproval(oauthCard("a", link), oauthCard("a", link))).toBe(false);
  });

  test("a typed question is never treated as the same approval", () => {
    const typed = { tool_name: "ask_user_confirm", input: { question: "Continue?" } };
    expect(asksForSameApproval(typed, typed)).toBe(false);
    expect(asksForSameApproval(typed, saveGate)).toBe(false);
  });
});
