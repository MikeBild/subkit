// Judging a production workflow against development is not a smaller answer,
// it is a different one.
//
// The dialog decided the environment from whether a schedule happened to be
// held. A production workflow that was not currently held got "development",
// where none of its connectors exist — so nearly every step reported
// `environment_mismatch` and the real problem sat in the middle of a wall of
// artefacts. Against production, exactly one issue remained.

import { expect, test } from "bun:test";
import { reviewEnvironment } from "./review-environment";

const NOW = new Date("2026-09-23T10:00:00.000Z");
const live = (env: string) => ({
  execution_environment: env,
  revoked_at: null,
  valid_until: "2026-10-23T10:00:00.000Z",
});

test("a live approval decides, even with no held schedule", () => {
  // The production case that broke: approved, running, nothing held.
  expect(reviewEnvironment([live("prod")], undefined, NOW)).toBe("prod");
});

test("a held schedule is used only when no approval says otherwise", () => {
  expect(reviewEnvironment([], { execution_mode: "prod" }, NOW)).toBe("prod");
  // And an approval outranks it: the approval is what the runs actually use.
  expect(reviewEnvironment([live("prod")], { execution_mode: "dev" }, NOW)).toBe("prod");
});

test("revoked and expired approvals are skipped for a live one", () => {
  const approvals = [
    { ...live("dev"), revoked_at: "2026-09-01T00:00:00.000Z" },
    { ...live("dev"), valid_until: "2026-09-02T00:00:00.000Z" },
    live("prod"),
  ];
  expect(reviewEnvironment(approvals, undefined, NOW)).toBe("prod");
});

test("a lapsed approval still beats guessing development", () => {
  // It no longer permits anything, but it is evidence of where this workflow
  // belongs — and that is all this decision needs.
  const expired = [{ ...live("prod"), valid_until: "2026-09-02T00:00:00.000Z" }];
  expect(reviewEnvironment(expired, undefined, NOW)).toBe("prod");
  const revoked = [{ ...live("prod"), revoked_at: "2026-09-02T00:00:00.000Z" }];
  expect(reviewEnvironment(revoked, undefined, NOW)).toBe("prod");
});

test("with nothing to go on it stays development", () => {
  // The safe half: a wrong guess there cannot approve production effects.
  expect(reviewEnvironment([], undefined, NOW)).toBe("dev");
  expect(reviewEnvironment(undefined, undefined, NOW)).toBe("dev");
  expect(reviewEnvironment([{ execution_environment: "staging" }], undefined, NOW)).toBe("dev");
  expect(reviewEnvironment([], { execution_mode: "something" }, NOW)).toBe("dev");
});
