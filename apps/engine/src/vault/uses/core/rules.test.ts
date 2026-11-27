import { describe, expect, test } from "bun:test";
import {
  cvvValid,
  PAY_RESULT_NOTE,
  paymentDecisionRefusal,
  paymentStep,
  payTicketValues,
  signInTicketValues,
  ticketAad,
  useStatusesBefore,
  useStatusOfOutcome,
  useStepAllowed,
} from "./rules.ts";

const NOW = new Date("2026-11-27T10:00:00Z");
const LOGIN = { username: "anna", password: "pw-1", totp_seed: "JBSWY3DPEHPK3PXP" };

describe("a vault use only moves forward and is never replayed", () => {
  test.each([
    ["pending", "running", true],
    ["pending", "failed", true],
    ["running", "submitted", true],
    ["running", "uncertain", true],
    ["submitted", "running", false],
    ["uncertain", "submitted", false],
    ["failed", "running", false],
    ["pending", "submitted", false],
  ] as const)("%s → %s is %p", (from, to, allowed) => {
    expect(useStepAllowed(from, to)).toBe(allowed);
  });

  test("the statuses a target may come from", () => {
    expect(useStatusesBefore("failed").sort()).toEqual(["pending", "running"]);
    expect(useStatusesBefore("running")).toEqual(["pending"]);
  });

  test.each([
    ["submitted", true, "submitted"],
    ["refused", false, "failed"],
    ["refused", true, "uncertain"],
    ["uncertain", true, "uncertain"],
    ["failed", false, "failed"],
    ["unknown", false, "uncertain"],
  ] as const)("outcome %s with filled %p is %s", (outcome, filled, status) => {
    expect(useStatusOfOutcome(outcome, filled)).toBe(status);
  });
});

describe("payments are decided once, by the card owner, in time", () => {
  const payment = {
    status: "pending" as const,
    owner_user_id: "u1",
    expires_at: new Date(NOW.getTime() + 60_000),
  };

  test("the owner may decide a fresh request", () => {
    expect(paymentDecisionRefusal(payment, "u1", NOW)).toBeNull();
  });

  test.each<
    [
      string,
      Parameters<typeof paymentDecisionRefusal>[0],
      string,
      ReturnType<typeof paymentDecisionRefusal>,
    ]
  >([
    ["someone else", payment, "u2", "not_card_owner"],
    ["a decided request", { ...payment, status: "approved" as const }, "u1", "payment_not_pending"],
    ["an expired request", { ...payment, expires_at: NOW }, "u1", "payment_expired"],
  ])("refuses %s", (_label, row, actor, code) => {
    expect(paymentDecisionRefusal(row, actor, NOW)).toBe(code);
  });

  test("steps follow pending → approved → consumed", () => {
    expect(paymentStep("approve")).toEqual({ from: "pending", to: "approved" });
    expect(paymentStep("consume")).toEqual({ from: "approved", to: "consumed" });
    expect(paymentStep("reject")).toEqual({ from: "pending", to: "rejected" });
    expect(paymentStep("expire")).toEqual({ from: "pending", to: "expired" });
  });

  test.each([
    ["123", true],
    ["1234", true],
    ["12", false],
    ["12345", false],
    ["12a", false],
  ])("security code %s is %p", (cvv, valid) => {
    expect(cvvValid(cvv)).toBe(valid);
  });

  test("the result tells the model not to submit again", () => {
    expect(PAY_RESULT_NOTE).toBe("submitted, not confirmed paid — do not submit again");
  });
});

describe("a ticket carries only the values this one use needs", () => {
  test("a password sign-in without a code field gets no seed", () => {
    expect(signInTicketValues(LOGIN, "password", { username: "e1", password: "e2" })).toEqual({
      username: "anna",
      password: "pw-1",
    });
  });

  test("a code sign-in gets the seed, never a code the engine computed", () => {
    expect(signInTicketValues(LOGIN, "totp", { code: "e3" })).toEqual({
      totp_seed: "JBSWY3DPEHPK3PXP",
    });
  });

  test("a payment ticket normalizes the card and adds the security code", () => {
    expect(
      payTicketValues(
        { number: "4242 4242-4242 4242", exp_month: 3, exp_year: 2030, holder: "Anna" },
        "987",
      ),
    ).toEqual({
      number: "4242424242424242",
      exp_month: "03",
      exp_year: "2030",
      holder: "Anna",
      cvv: "987",
    });
  });

  test("the ticket's additional data binds tenant and ticket", () => {
    expect(ticketAad("t1", "k1")).toBe("ticket:t1:k1");
  });
});
