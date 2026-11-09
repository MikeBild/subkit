import { describe, expect, test } from "bun:test";
import { authority, input, NOW } from "./workflow-automation.test-helpers.ts";
import {
  type AutomationAction,
  authorityIsLive,
  automationActionPermitted,
  automationEnvironment,
  automationEnvironmentDecision,
  automationEnvironmentUndecided,
  automationNeedsMoreApprovals,
  automationRepairAction,
  grantNeedsExtension,
  observedAuthorityState,
} from "./workflow-automation.ts";

describe("authority facts", () => {
  test("classifies temporal and run-bound authority states", () => {
    expect(observedAuthorityState(authority(), NOW)).toBe("approved");
    expect(observedAuthorityState(authority({ state: "revoked" }), NOW)).toBe("revoked");
    expect(observedAuthorityState(authority({ valid_until: "bad" }), NOW)).toBe("unavailable");
    expect(observedAuthorityState(authority({ valid_until: "2020-01-01T00:00:00Z" }), NOW)).toBe(
      "expired",
    );
    expect(observedAuthorityState(authority({ valid_from: "2027-01-01T00:00:00Z" }), NOW)).toBe(
      "not_yet_valid",
    );
    expect(observedAuthorityState(authority({ valid_from: "2026-01-15T12:00:00.000Z" }), NOW)).toBe(
      "approved",
    );
    expect(
      observedAuthorityState(authority({ valid_until: "2026-01-15T12:00:00.000Z" }), NOW),
    ).toBe("expired");
    expect(
      observedAuthorityState(authority({ valid_until: null, remaining_runs: null }), NOW),
    ).toBe("approved");
    expect(observedAuthorityState(authority({ valid_from: "bad" }), NOW)).toBe("unavailable");
    expect(observedAuthorityState(authority({ remaining_runs: 0 }), NOW)).toBe("exhausted");
    expect(authorityIsLive(authority(), NOW)).toBe(true);
    expect(authorityIsLive(authority({ active_version: false }), NOW)).toBe(false);
    expect(grantNeedsExtension(authority({ valid_until: "2026-01-16T00:00:00Z" }), NOW)).toBe(true);
    expect(
      grantNeedsExtension(authority({ valid_until: null, remaining_runs: 0, max_runs: 10 }), NOW),
    ).toBe(true);
    expect(grantNeedsExtension(authority(), NOW)).toBe(false);
    expect(
      grantNeedsExtension(
        authority({ valid_until: "2026-01-18T12:00:00.000Z", remaining_runs: 1, max_runs: 10 }),
        NOW,
      ),
    ).toBe(false);
    expect(
      grantNeedsExtension(
        authority({ valid_until: "2026-02-01T00:00:00.000Z", remaining_runs: 0, max_runs: 10 }),
        NOW,
      ),
    ).toBe(true);
  });

  test("keeps all validity and quota boundaries observable", () => {
    for (const [overrides, expected] of [
      [{ state: "revoked" as const }, "revoked"],
      [{ state: "expired" as const }, "expired"],
      [{ valid_until: "2026-01-15T11:59:59.999Z" }, "expired"],
      [{ valid_from: "2026-01-15T12:00:00.001Z" }, "not_yet_valid"],
      [{ remaining_runs: -1 }, "exhausted"],
      [{ remaining_runs: null }, "approved"],
    ] as const)
      expect(observedAuthorityState(authority(overrides), NOW)).toBe(expected);
    for (const [overrides, expected] of [
      [{ valid_until: null, remaining_runs: null, max_runs: null }, false],
      [{ valid_until: null, remaining_runs: 1, max_runs: 10 }, false],
      [{ valid_until: null, remaining_runs: 0, max_runs: 10 }, true],
      [{ valid_until: null, remaining_runs: 1, max_runs: 0 }, false],
    ] as const)
      expect(grantNeedsExtension(authority(overrides), NOW)).toBe(expected);
  });
});

describe("automation environment", () => {
  test("selects pending, started, hook and existing-authority environments", () => {
    expect(
      automationEnvironmentDecision(
        input({
          status: {
            schedules: [
              {
                schedule_id: "s",
                state: "approval_required",
                cron: "*",
                timezone: "UTC",
                environment: "dev",
                next_run_at: null,
              },
            ],
            inbound_hooks: [],
          },
        }),
      ),
    ).toEqual({ environment: "dev", reason: "schedule" });
    expect(
      automationEnvironmentDecision(
        input({
          schedules: [
            { id: "s", cron: "*", timezone: "UTC", execution_mode: "prod", paused: false },
          ],
          status: null,
          authorities: [],
        }),
      ),
    ).toEqual({ environment: "prod", reason: "schedule" });
    expect(automationEnvironmentDecision(input({ workflow: { webhooks_active: 1 } }))).toEqual({
      environment: "prod",
      reason: "inbound_hook",
    });
    expect(
      automationEnvironmentDecision(
        input({ authorities: [authority({ execution_environment: "prod" })] }),
      ),
    ).toEqual({ environment: "prod", reason: "existing_approval" });
    expect(
      automationEnvironmentDecision(
        input({ authorities: [authority({ revoked_at: "2026-01-01T00:00:00Z" })] }),
      ),
    ).toEqual({ environment: "dev", reason: "existing_approval" });
    expect(
      automationEnvironmentDecision(
        input({
          schedules: [
            { id: "s", cron: "*", timezone: "UTC", execution_mode: "prod", paused: false },
          ],
          status: null,
          authorities: [authority({ execution_environment: "dev" })],
        }),
      ),
    ).toEqual({ environment: "prod", reason: "schedule" });
    expect(
      automationEnvironmentUndecided(
        input({ authorities: null, schedules: [], status: { schedules: [], inbound_hooks: [] } }),
      ),
    ).toBe(false);
    expect(automationEnvironment(input({ authorities: [], connectorEnvironment: "prod" }))).toBe(
      "prod",
    );
  });

  test("gives pending hooks priority and keeps their reason", () => {
    expect(
      automationEnvironmentDecision(
        input({
          status: {
            schedules: [],
            inbound_hooks: [
              {
                inbound_hook_id: "hook-1",
                slug: "orders",
                state: "approval_required",
                environment: "prod",
              },
            ],
          },
        }),
      ),
    ).toEqual({ environment: "prod", reason: "inbound_hook" });
  });

  test("uses a live existing approval only after ignoring revoked and expired authorities", () => {
    expect(
      automationEnvironmentDecision(
        input({
          authorities: [
            authority({ execution_environment: "dev", revoked_at: "2026-01-10T00:00:00Z" }),
            authority({
              execution_environment: "prod",
              valid_until: "2020-01-01T00:00:00Z",
            }),
            authority({ execution_environment: "prod" }),
          ],
        }),
      ),
    ).toEqual({ environment: "prod", reason: "existing_approval" });
  });

  test("falls back deterministically for absent data and active dev/prod triggers", () => {
    expect(
      automationEnvironmentDecision(input({ authorities: [], schedules: [], status: null })),
    ).toBeNull();
    expect(automationEnvironment(input({ authorities: null, schedules: [], status: null }))).toBe(
      "dev",
    );
    expect(
      automationEnvironmentDecision(
        input({
          authorities: [],
          status: null,
          schedules: [
            { id: "d", cron: "*", timezone: "UTC", execution_mode: "dev", paused: false },
          ],
        }),
      ),
    ).toEqual({ environment: "dev", reason: "schedule" });
  });
});

describe("automation repair and permissions", () => {
  test("chooses repair routes and enforces action rights", () => {
    expect(automationRepairAction(undefined, false)).toEqual({
      kind: "repair",
      via: "chat",
      stepId: null,
    });
    expect(
      automationRepairAction(
        { subject: { step_id: "s" }, fixer: true, candidate_id: "c", remedy_kind: "x" },
        true,
      ),
    ).toEqual({ kind: "repair", via: "review", stepId: "s" });
    expect(
      automationRepairAction({ subject: { step_id: "s" }, remedy_kind: "prepare" }, false),
    ).toEqual({ kind: "repair", via: "prepare", stepId: "s" });
    expect(
      automationRepairAction(
        { subject: { step_id: "s" }, fixer: true, candidate_id: null, remedy_kind: "x" },
        true,
      ),
    ).toEqual({ kind: "repair", via: "auto", stepId: "s" });
    const rights = { write: false, run: true, chat: true };
    expect(automationActionPermitted({ kind: "view" }, rights)).toBe(true);
    expect(automationActionPermitted({ kind: "apply" }, rights)).toBe(false);
    expect(automationActionPermitted({ kind: "resume", scheduleIds: ["s"] }, rights)).toBe(false);
    expect(automationActionPermitted({ kind: "grant" }, rights)).toBe(false);
    expect(automationActionPermitted({ kind: "extend" }, rights)).toBe(false);
    expect(
      automationActionPermitted({ kind: "repair", via: "prepare", stepId: null }, rights),
    ).toBe(true);
    expect(automationActionPermitted({ kind: "repair", via: "chat", stepId: null }, rights)).toBe(
      true,
    );
    expect(automationActionPermitted({ kind: "repair", via: "review", stepId: null }, rights)).toBe(
      false,
    );
    expect(
      automationActionPermitted(
        { kind: "repair", via: "auto", stepId: null },
        { ...rights, write: true },
      ),
    ).toBe(true);
    for (const action of [
      { kind: "resume", scheduleIds: ["s"] },
      { kind: "apply" },
      { kind: "grant" },
      { kind: "extend" },
    ] as AutomationAction[])
      expect(automationActionPermitted(action, { write: true, run: false, chat: false })).toBe(
        true,
      );
    expect(automationNeedsMoreApprovals({ state: "approved", grant: null }, true)).toBe(true);
    expect(automationNeedsMoreApprovals({ state: "grant", grant: null }, true)).toBe(false);
    expect(automationNeedsMoreApprovals({ state: "approved", grant: authority() }, true)).toBe(
      false,
    );
    expect(automationNeedsMoreApprovals({ state: "approved", grant: null }, false)).toBe(false);
  });
});
