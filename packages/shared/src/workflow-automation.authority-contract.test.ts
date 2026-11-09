import { expect, test } from "bun:test";
import {
  authorityIsLive,
  automationEnvironmentDecision,
  grantNeedsExtension,
  observedAuthorityState,
  type WorkflowAuthority,
} from "./workflow-automation.ts";

const NOW = Date.parse("2026-01-15T12:00:00.000Z");
const DAY = 86_400_000;
const instant = (offset: number) => new Date(NOW + offset).toISOString();
const authority = (overrides: Partial<WorkflowAuthority> = {}): WorkflowAuthority => ({
  execution_environment: "prod",
  active_version: true,
  ready_for_new_run: true,
  state: "approved",
  valid_from: instant(-DAY),
  valid_until: null,
  revoked_at: null,
  remaining_runs: null,
  max_runs: null,
  reserved_runs: 0,
  ...overrides,
});

test("recorded rejection states retain their reason even when dates are invalid", () => {
  for (const state of [
    "not_yet_valid",
    "expired",
    "revoked",
    "superseded",
    "exhausted",
    "invalidated",
    "unavailable",
  ] as const) {
    expect(
      observedAuthorityState(
        authority({ state, valid_from: "invalid", valid_until: "invalid" }),
        NOW,
      ),
    ).toBe(state);
  }
});

test("approval validity uses inclusive expiry and start boundaries with explicit precedence", () => {
  const cases: Array<[Partial<WorkflowAuthority>, ReturnType<typeof observedAuthorityState>]> = [
    [{ valid_from: instant(0) }, "approved"],
    [{ valid_from: instant(1) }, "not_yet_valid"],
    [{ valid_until: instant(0) }, "expired"],
    [{ valid_until: instant(-1) }, "expired"],
    [{ valid_until: instant(1) }, "approved"],
    [{ valid_from: "invalid" }, "unavailable"],
    [{ valid_until: "invalid" }, "unavailable"],
    [{ remaining_runs: 0 }, "exhausted"],
    [{ remaining_runs: -1 }, "exhausted"],
    [{ remaining_runs: 1 }, "approved"],
    [{ valid_until: instant(0), valid_from: instant(1), remaining_runs: 0 }, "expired"],
    [{ valid_from: instant(1), remaining_runs: 0 }, "not_yet_valid"],
  ];
  for (const [overrides, expected] of cases)
    expect(observedAuthorityState(authority(overrides), NOW)).toBe(expected);
});

test("live authority requires both active-version and admission readiness", () => {
  expect(authorityIsLive(authority(), NOW)).toBe(true);
  for (const overrides of [
    { active_version: false },
    { ready_for_new_run: false },
    { valid_until: instant(0) },
    { remaining_runs: 0 },
    { state: "revoked" as const },
  ]) {
    expect(authorityIsLive(authority(overrides), NOW)).toBe(false);
  }
});

test("extension requires strictly less than three days or ten percent of the run budget", () => {
  for (const [valid_until, expected] of [
    [instant(3 * DAY - 1), true],
    [instant(3 * DAY), false],
    [instant(3 * DAY + 1), false],
    [instant(-1), true],
    [null, false],
    ["invalid", false],
  ] as const) {
    expect(grantNeedsExtension({ valid_until, max_runs: null, remaining_runs: null }, NOW)).toBe(
      expected,
    );
  }
  for (const [remaining_runs, max_runs, expected] of [
    [9, 100, true],
    [10, 100, false],
    [11, 100, false],
    [0, 100, true],
    [null, 100, false],
    [0, null, false],
    [0, 0, false],
    [-1, 0, false],
    [0, -1, false],
  ] as const) {
    expect(grantNeedsExtension({ valid_until: null, remaining_runs, max_runs }, NOW)).toBe(
      expected,
    );
  }
  expect(
    grantNeedsExtension({ valid_until: instant(10 * DAY), remaining_runs: 1, max_runs: 100 }, NOW),
  ).toBe(true);
  expect(
    grantNeedsExtension({ valid_until: instant(DAY), remaining_runs: 100, max_runs: 100 }, NOW),
  ).toBe(true);
});

const environmentDecision = (authorities: WorkflowAuthority[]) =>
  automationEnvironmentDecision({
    workflow: {},
    schedules: [],
    status: { schedules: [], inbound_hooks: [] },
    authorities,
    now: NOW,
  });

test("review reuses the first non-revoked non-expired approval environment", () => {
  expect(
    environmentDecision([
      authority({ execution_environment: "dev", valid_until: instant(0) }),
      authority(),
    ]),
  ).toEqual({ environment: "prod", reason: "existing_approval" });
  expect(
    environmentDecision([
      authority({ revoked_at: instant(-1) }),
      authority({ execution_environment: "dev" }),
    ]),
  ).toEqual({ environment: "dev", reason: "existing_approval" });
  expect(
    environmentDecision([
      authority({ valid_until: instant(1) }),
      authority({ execution_environment: "dev" }),
    ]),
  ).toEqual({ environment: "prod", reason: "existing_approval" });
  expect(environmentDecision([authority({ valid_until: instant(-1) })])).toEqual({
    environment: "prod",
    reason: "existing_approval",
  });
  expect(environmentDecision([])).toBeNull();
});
