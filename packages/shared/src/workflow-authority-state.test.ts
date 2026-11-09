import { expect, test } from "bun:test";
import { observedAuthorityState, type WorkflowAuthority } from "./workflow-automation.ts";

const now = Date.parse("2026-01-02T00:00:00Z");
const approved = {
  state: "approved" as const,
  valid_from: "2026-01-01T00:00:00Z",
  valid_until: null,
  remaining_runs: null,
};

test("stored terminal states prevail over temporal and run limits", () => {
  for (const state of [
    "revoked",
    "superseded",
    "invalidated",
    "unavailable",
    "expired",
    "exhausted",
    "not_yet_valid",
  ] as const) {
    expect(
      observedAuthorityState({ ...approved, state, valid_from: "invalid", remaining_runs: 0 }, now),
    ).toBe(state);
  }
});

test("authority bounds include the start and exclude the expiry instant", () => {
  expect(observedAuthorityState(approved, now)).toBe("approved");
  const start = { ...approved, valid_from: new Date(now).toISOString() };
  expect(observedAuthorityState(start, now - 1)).toBe("not_yet_valid");
  expect(observedAuthorityState(start, now)).toBe("approved");
  const end = { ...approved, valid_until: new Date(now).toISOString() };
  expect(observedAuthorityState(end, now - 1)).toBe("approved");
  expect(observedAuthorityState(end, now)).toBe("expired");
  expect(observedAuthorityState(end, now + 1)).toBe("expired");
});

test("invalid dates and exhausted limits cannot authorize a run", () => {
  for (const invalid of [{ valid_from: "invalid" }, { valid_until: "invalid" }])
    expect(observedAuthorityState({ ...approved, ...invalid }, now)).toBe("unavailable");
  for (const remaining_runs of [-1, 0, 1, null])
    expect(observedAuthorityState({ ...approved, remaining_runs }, now)).toBe(
      remaining_runs !== null && remaining_runs <= 0 ? "exhausted" : "approved",
    );
  const expired: Pick<WorkflowAuthority, keyof typeof approved> = {
    ...approved,
    valid_until: new Date(now).toISOString(),
    remaining_runs: 0,
  };
  expect(observedAuthorityState(expired, now)).toBe("expired");
});
