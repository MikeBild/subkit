import { describe, expect, test } from "bun:test";
import { APPROVAL_WITH_CHANGE_MESSAGE } from "./confirm-change.ts";
import { validateElicitationAnswer } from "./validate-answer.ts";

const card = {
  question: "Send the mail to anna@firma.de?",
  commit_intent: { kind: "execute_confirmed_tool_call", payload: { tool: "call_connector" } },
};

describe("a yes with a change is not a yes", () => {
  test("a plain approval of a bound action is accepted", () => {
    expect(validateElicitationAnswer("ask_user_confirm", card, { confirmed: true })).toEqual({
      ok: true,
    });
    for (const reason of ["", "  ", "ok", "Ja!", "Looks good.", "Danke"]) {
      expect(
        validateElicitationAnswer("ask_user_confirm", card, { confirmed: true, reason }),
      ).toEqual({ ok: true });
    }
  });

  test("an approval that carries a change keeps the card open", () => {
    const changed = [
      { confirmed: true, reason: "but send it to bob@firma.de instead" },
      { approved: true, feedback: "ja, aber erst morgen" },
      { confirmed: true, changes: "500 statt 50" },
    ];
    for (const output of changed) {
      expect(validateElicitationAnswer("ask_user_confirm", card, output)).toEqual({
        ok: false,
        field_errors: [{ name: "confirmed", message: APPROVAL_WITH_CHANGE_MESSAGE }],
      });
    }
    expect(
      validateElicitationAnswer("ask_user_confirm", card, { confirmed: true }, "nur an Anna"),
    ).toEqual({
      ok: false,
      field_errors: [{ name: "confirmed", message: APPROVAL_WITH_CHANGE_MESSAGE }],
    });
  });

  test("a decline with a comment is an ordinary decline", () => {
    expect(
      validateElicitationAnswer("ask_user_confirm", card, {
        confirmed: false,
        reason: "send it to bob instead",
      }),
    ).toEqual({ ok: true });
  });

  test("a question that binds no action may carry a remark", () => {
    expect(
      validateElicitationAnswer(
        "ask_user_confirm",
        { question: "Shall I continue?" },
        { confirmed: true, reason: "and keep it short" },
      ),
    ).toEqual({ ok: true });
  });
});
