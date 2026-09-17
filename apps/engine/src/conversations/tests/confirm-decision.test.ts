// Confirm-answer interpretation is one source of truth across every
// surface. Regression guard for the portal-approval bug: the web portal
// posts `{ approved: true }`, but the auto-persist write gate used to
// require `{ confirmed: true }` — so an explicitly-approved
// `save_workflow_draft` was injected back to the LLM as `user_declined`
// and the workflow never committed. These tests pin the three readers
// (interpreter, checkDecline, validateElicitationAnswer) to the same
// decision for the full matrix of confirm shapes.

import { describe, expect, test } from "bun:test";
import { checkDecline } from "../persistence/auto-persist/synthetic.ts";
import {
  type ConfirmDecision,
  interpretConfirmDecision,
} from "../tools/ask-user/interpret-confirm.ts";
import { validateElicitationAnswer } from "../tools/ask-user/validate-answer.ts";

describe("interpretConfirmDecision", () => {
  const cases: Array<[unknown, ConfirmDecision]> = [
    [{ confirmed: true }, "confirmed"], // MCP / sk-cli canonical
    [{ approved: true }, "confirmed"], // web portal spelling (the bug)
    [{ confirmed: false }, "declined"],
    [{ approved: false }, "declined"], // portal decline spelling
    [{ declined: true }, "declined"],
    [{ confirmed: true, declined: true }, "declined"], // decline wins
    [{}, "ambiguous"],
    [{ tested: true }, "ambiguous"],
    [null, "ambiguous"],
    [undefined, "ambiguous"],
    ["yes", "ambiguous"],
    [["confirmed"], "ambiguous"],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input) ?? "undefined"} → ${expected}`, () => {
      expect(interpretConfirmDecision(input)).toBe(expected);
    });
  }
});

describe("checkDecline(ask_user_confirm) matches the interpreter", () => {
  test("portal {approved:true} is NOT a decline — the write proceeds", () => {
    expect(checkDecline("ask_user_confirm", { approved: true })).toBeNull();
  });

  test("canonical {confirmed:true} is NOT a decline", () => {
    expect(checkDecline("ask_user_confirm", { confirmed: true })).toBeNull();
  });

  test("portal {approved:false} → user_declined (rejected)", () => {
    expect(checkDecline("ask_user_confirm", { approved: false })).toEqual({
      error_code: "user_declined",
      reason: "operator_rejected_confirmation",
    });
  });

  test("{confirmed:false} → user_declined (rejected)", () => {
    expect(checkDecline("ask_user_confirm", { confirmed: false })).toEqual({
      error_code: "user_declined",
      reason: "operator_rejected_confirmation",
    });
  });

  test("ambiguous {} → user_declined (did not confirm)", () => {
    expect(checkDecline("ask_user_confirm", {})).toEqual({
      error_code: "user_declined",
      reason: "operator_did_not_confirm",
    });
  });

  test("dismissed (null output) → user_declined (dismissed)", () => {
    expect(checkDecline("ask_user_confirm", null)).toEqual({
      error_code: "user_declined",
      reason: "operator_dismissed_elicitation",
    });
  });

  // Structural guarantee: a confirm clears the write gate iff the shared
  // interpreter reads it as "confirmed". This is what makes the log-side
  // mirror and the write-side gate impossible to diverge again.
  test("write gate clears iff interpreter says confirmed", () => {
    for (const out of [
      { confirmed: true },
      { approved: true },
      { confirmed: false },
      { approved: false },
      { declined: true },
      {},
      { tested: true },
    ]) {
      const clears = checkDecline("ask_user_confirm", out) === null;
      expect(clears).toBe(interpretConfirmDecision(out) === "confirmed");
    }
  });
});

describe("validateElicitationAnswer(ask_user_confirm)", () => {
  const input = { question: "Commit?" };

  test("portal {approved:true} passes validation", () => {
    expect(validateElicitationAnswer("ask_user_confirm", input, { approved: true })).toEqual({
      ok: true,
    });
  });

  test("{confirmed:true} passes validation", () => {
    expect(validateElicitationAnswer("ask_user_confirm", input, { confirmed: true })).toEqual({
      ok: true,
    });
  });

  test("declines pass through unvalidated", () => {
    expect(validateElicitationAnswer("ask_user_confirm", input, { confirmed: false })).toEqual({
      ok: true,
    });
    expect(validateElicitationAnswer("ask_user_confirm", input, { approved: false })).toEqual({
      ok: true,
    });
  });

  test("ambiguous confirm body is rejected (re-prompt, not silent decline)", () => {
    const verdict = validateElicitationAnswer("ask_user_confirm", input, { surprise: 1 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.field_errors[0]?.name).toBe("confirmed");
    }
  });
});

test("declining a form never treats the decline marker as submitted input", () => {
  expect(checkDecline("ask_user_form", { declined: true })).toEqual({
    error_code: "user_declined",
    reason: "operator_rejected_confirmation",
  });
  expect(
    checkDecline("ask_user_form", { confirmed: false, values: { recipient: "must-not-run" } })
      ?.error_code,
  ).toBe("user_declined");
  expect(checkDecline("ask_user_form", { values: { enabled: false } })).toBeNull();
});
