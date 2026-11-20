import { describe, expect, test } from "bun:test";
import { authority, input } from "./workflow-automation.test-helpers.ts";
import {
  automationEnvironmentUndecided,
  automationRepairAction,
  automationState,
} from "./workflow-automation.ts";

describe("workflow automation boundary contracts", () => {
  test("uses local pauses for verified rows and preserves chat repair for non-preparable diagnostics", () => {
    const state = automationState(
      input({
        schedules: [
          { id: "s", cron: "local", timezone: "UTC", execution_mode: "dev", paused: true },
        ],
        status: {
          schedules: [
            {
              schedule_id: "s",
              state: "authorized",
              cron: "remote",
              timezone: "UTC",
              environment: "dev",
              next_run_at: null,
            },
          ],
          inbound_hooks: [],
        },
        authorities: [authority()],
      }),
    );
    expect(state).toMatchObject({
      state: "paused",
      triggers: [{ id: "s", paused: true }],
      primaryAction: { kind: "resume", scheduleIds: ["s"] },
    });
    expect(
      automationRepairAction({ subject: { step_id: "chat-step" }, remedy_kind: "manual" }, false),
    ).toEqual({ kind: "repair", via: "chat", stepId: "chat-step" });
  });

  test("keeps null targets, empty starts, and repair-required rows observable", () => {
    expect(
      automationState(
        input({
          workflow: {},
          authorities: [],
          schedules: [],
          status: { schedules: [], inbound_hooks: [] },
        }),
      ),
    ).toMatchObject({
      state: "manual",
      target: null,
    });
    expect(
      automationState(
        input({
          workflow: { lifecycle: "active", current_version_id: "a", draft_version_id: "d" },
          draft: { version_id: "d", version: 9 },
          schedules: [],
          status: { schedules: [], inbound_hooks: [] },
        }),
      ),
    ).toMatchObject({ state: "apply", pendingEnvironments: ["dev"] });
    expect(
      automationState(
        input({
          status: {
            schedules: [
              {
                schedule_id: "r",
                state: "repair_required",
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
    ).toMatchObject({
      state: "repair",
      primaryAction: { kind: "repair", via: "chat", stepId: null },
    });
    expect(
      automationEnvironmentUndecided(
        input({ authorities: [], schedules: [], status: { schedules: [], inbound_hooks: [] } }),
      ),
    ).toBe(true);
    expect(
      automationState(
        input({
          diagnosis: null,
          authorities: [],
          schedules: [],
          status: { schedules: [], inbound_hooks: [] },
        }),
      ),
    ).toMatchObject({ state: "manual" });
    expect(
      automationState(
        input({
          diagnosis: null,
          status: {
            schedules: [
              {
                schedule_id: "r",
                state: "input_required",
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
    ).toMatchObject({ state: "repair" });
    expect(
      automationState(
        input({ schedules: null, status: { schedules: [], inbound_hooks: [] }, authorities: [] }),
      ),
    ).toMatchObject({ state: "manual", triggers: [] });
    expect(automationState(input({ schedules: null, status: null }))).toMatchObject({
      state: "unknown",
      triggers: [],
    });
  });

  test("does not treat a listed hook as hidden when schedules are also listed", () => {
    expect(
      automationState(
        input({
          workflow: { lifecycle: "active", current_version_id: "v", webhooks_active: 1 },
          status: {
            schedules: [
              {
                schedule_id: "d",
                state: "authorized",
                cron: "*",
                timezone: "UTC",
                environment: "dev",
                next_run_at: null,
              },
            ],
            inbound_hooks: [
              { inbound_hook_id: "h", slug: "h", state: "authorized", environment: "prod" },
            ],
          },
          authorities: [authority({ execution_environment: "prod" })],
        }),
      ),
    ).toMatchObject({ state: "approved", primaryAction: { kind: "view" } });
  });

  test("excludes paused rows from authorization and preserves diagnosis-current routing", () => {
    expect(
      automationState(
        input({
          status: {
            schedules: [
              {
                schedule_id: "run",
                state: "authorized",
                cron: "*",
                timezone: "UTC",
                environment: "dev",
                next_run_at: null,
              },
            ],
            inbound_hooks: [
              { inbound_hook_id: "paused", slug: "paused", state: "paused", environment: "prod" },
            ],
          },
          authorities: [authority()],
        }),
      ),
    ).toMatchObject({ state: "approved", primaryAction: { kind: "view" } });
    expect(
      automationState(
        input({
          diagnosis: {
            is_current: false,
            diagnoses: [
              { subject: { step_id: "x" }, fixer: true, candidate_id: "c", remedy_kind: "manual" },
            ],
          },
        }),
      ),
    ).toMatchObject({
      state: "repair",
      primaryAction: { kind: "repair", via: "chat", stepId: "x" },
    });
    expect(automationState(input()).facts.untilRevoked).toBe(false);
  });

  test("only an approval without an end date and without a run limit counts as until revoked", () => {
    const facts = (overrides: Parameters<typeof authority>[0]) =>
      automationState(input({ authorities: [authority(overrides)] })).facts;
    expect(facts({ valid_until: null, max_runs: null, remaining_runs: null })).toMatchObject({
      untilRevoked: true,
      runsLeft: null,
      runsMax: null,
    });
    expect(facts({ valid_until: null, max_runs: 50, remaining_runs: 46 })).toMatchObject({
      untilRevoked: false,
      validUntil: null,
      runsLeft: 46,
      runsMax: 50,
    });
    expect(facts({ max_runs: null, remaining_runs: null }).untilRevoked).toBe(false);
    expect(facts({}).untilRevoked).toBe(false);
  });

  test("keeps every running environment for prepared workflow and hidden-hook verification", () => {
    expect(
      automationState(
        input({
          workflow: { lifecycle: "active", current_version_id: "v", draft_version_id: "d" },
          draft: { version_id: "d", version: 4 },
          schedules: [
            { id: "d", cron: "*", timezone: "UTC", execution_mode: "dev", paused: false },
            { id: "p", cron: "*", timezone: "UTC", execution_mode: "prod", paused: false },
          ],
          status: null,
        }),
      ),
    ).toMatchObject({ state: "apply", pendingEnvironments: ["prod", "dev"] });
    expect(
      automationState(
        input({
          workflow: { lifecycle: "active", current_version_id: "v", webhooks_active: 1 },
          status: {
            schedules: [
              {
                schedule_id: "d",
                state: "authorized",
                cron: "*",
                timezone: "UTC",
                environment: "dev",
                next_run_at: null,
              },
              {
                schedule_id: "p",
                state: "authorized",
                cron: "*",
                timezone: "UTC",
                environment: "prod",
                next_run_at: null,
              },
            ],
            inbound_hooks: [],
          },
          authorities: [authority({ execution_environment: "prod" })],
        }),
      ),
    ).toMatchObject({ state: "approved", primaryAction: { kind: "view" } });
  });

  test("turns every unread dependency into unknown only after higher-priority states", () => {
    const unknowns = [
      { authorities: null },
      { schedules: null, status: null },
      { unanswered: { status: true, diagnosis: false } },
      { unanswered: { status: false, diagnosis: true } },
    ];
    for (const overrides of unknowns)
      expect(automationState(input(overrides))).toMatchObject({
        state: "unknown",
        pendingEnvironments: [],
        primaryAction: null,
      });
    expect(
      automationState(
        input({
          authorities: null,
          workflow: { lifecycle: "active", current_version_id: "a", draft_version_id: "d" },
          draft: { version_id: "d", version: 3 },
        }),
      ),
    ).toMatchObject({ state: "apply" });
  });

  test("retains inactive, invalid, prepared, and repair precedence over later authority decisions", () => {
    const activeGrant = authority();
    expect(
      automationState(
        input({
          workflow: { invalid: true },
          authorities: [activeGrant],
          schedules: [{ id: "p", cron: "*", timezone: "UTC", execution_mode: "dev", paused: true }],
        }),
      ),
    ).toMatchObject({
      state: "invalid",
      primaryAction: { kind: "repair", via: "chat", stepId: null },
      secondaryAction: { kind: "view" },
    });
    expect(
      automationState(
        input({
          workflow: {
            lifecycle: "active",
            current_version_id: "a",
            draft_version_id: "d",
            invalid: true,
          },
          draft: { version_id: "d", version: 2 },
        }),
      ),
    ).toMatchObject({ state: "apply", facts: { preparedVersion: 2 } });
    expect(
      automationState(
        input({
          workflow: { lifecycle: "draft", current_version_id: "a" },
          diagnosis: {
            is_current: false,
            diagnoses: [{ subject: { step_id: "x" }, remedy_kind: "x" }],
          },
        }),
      ),
    ).toMatchObject({ state: "repair", facts: { blockedStep: "x" } });
  });

  test("returns separate live and historical approvals without losing order or environments", () => {
    const expired = authority({
      execution_environment: "dev",
      valid_until: "2020-01-01T00:00:00Z",
    });
    const prod = authority({ execution_environment: "prod" });
    const dev = authority({ execution_environment: "dev" });
    const state = automationState(
      input({
        schedules: [{ id: "p", cron: "*", timezone: "UTC", execution_mode: "prod", paused: false }],
        status: null,
        authorities: [expired, prod, dev],
      }),
    );
    expect(state.grant).toBe(prod);
    expect(state.alsoValid).toEqual([dev]);
    expect(state.history).toEqual([expired]);
    expect(state.environment).toBe("prod");
  });

  test("requires a verified production schedule when an active hook is absent from status", () => {
    const base = {
      workflow: { lifecycle: "active", current_version_id: "v", webhooks_active: 1 },
      authorities: [authority({ execution_environment: "prod" })],
      status: {
        schedules: [
          {
            schedule_id: "d",
            state: "authorized" as const,
            cron: "*",
            timezone: "UTC",
            environment: "dev" as const,
            next_run_at: null,
          },
        ],
        inbound_hooks: [],
      },
    };
    expect(automationState(input(base))).toMatchObject({ state: "unknown", grant: null });
    expect(automationState(input({ ...base, authorities: [] }))).toMatchObject({
      state: "grant",
      primaryAction: { kind: "grant" },
    });
    expect(
      automationState(
        input({
          ...base,
          status: {
            schedules: [
              {
                schedule_id: "p",
                state: "authorized",
                cron: "*",
                timezone: "UTC",
                environment: "prod",
                next_run_at: null,
              },
            ],
            inbound_hooks: [],
          },
        }),
      ),
    ).toMatchObject({
      state: "approved",
      primaryAction: { kind: "view" },
    });
  });

  test("does not confuse manual, grant, approved, and view-only outputs", () => {
    expect(
      automationState(
        input({ authorities: [], schedules: [], status: { schedules: [], inbound_hooks: [] } }),
      ),
    ).toMatchObject({
      state: "manual",
      primaryAction: { kind: "grant" },
      pendingEnvironments: ["dev"],
    });
    expect(
      automationState(
        input({
          schedules: [
            { id: "p", cron: "*", timezone: "UTC", execution_mode: "prod", paused: false },
          ],
          status: null,
          authorities: [],
        }),
      ),
    ).toMatchObject({ state: "grant", primaryAction: { kind: "grant" }, secondaryAction: null });
    expect(
      automationState(
        input({
          schedules: [
            { id: "p", cron: "*", timezone: "UTC", execution_mode: "prod", paused: false },
          ],
          status: null,
          authorities: [
            authority({ execution_environment: "prod", valid_until: "2026-02-01T00:00:00.000Z" }),
          ],
        }),
      ),
    ).toMatchObject({ state: "approved", primaryAction: { kind: "view" }, secondaryAction: null });
  });
});
