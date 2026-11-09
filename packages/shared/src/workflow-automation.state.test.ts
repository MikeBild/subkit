import { describe, expect, test } from "bun:test";
import { authority, input } from "./workflow-automation.test-helpers.ts";
import { automationState } from "./workflow-automation.ts";

describe("automationState", () => {
  test("materializes each workflow state and action", () => {
    expect(automationState(input({ workflow: { invalid: true } })).state).toBe("invalid");
    expect(
      automationState(
        input({
          schedules: [{ id: "s", cron: "*", timezone: "UTC", execution_mode: "dev", paused: true }],
          status: null,
        }),
      ).state,
    ).toBe("paused");
    expect(
      automationState(
        input({
          workflow: { lifecycle: "active", current_version_id: "a", draft_version_id: "d" },
        }),
      ).state,
    ).toBe("apply");
    expect(
      automationState(
        input({
          diagnosis: {
            is_current: false,
            diagnoses: [{ subject: { step_id: "s" }, remedy_kind: "prepare" }],
          },
        }),
      ).state,
    ).toBe("repair");
    expect(automationState(input({ unanswered: { status: true, diagnosis: false } })).state).toBe(
      "unknown",
    );
    expect(
      automationState(input({ workflow: { lifecycle: "draft", current_version_id: "a" } })).state,
    ).toBe("manual");
    expect(
      automationState(
        input({
          schedules: [
            { id: "s", cron: "*", timezone: "UTC", execution_mode: "dev", paused: false },
          ],
          authorities: [],
        }),
      ).state,
    ).toBe("grant");
    expect(
      automationState(
        input({
          schedules: [
            { id: "s", cron: "*", timezone: "UTC", execution_mode: "dev", paused: false },
          ],
          authorities: [authority()],
        }),
      ).state,
    ).toBe("approved");
    expect(automationState(input({ authorities: [authority()], schedules: [] })).state).toBe(
      "approved",
    );
    expect(automationState(input()).state).toBe("manual");
    expect(
      automationState(
        input({
          schedules: [
            { id: "local", cron: "*", timezone: "UTC", execution_mode: "dev", paused: false },
          ],
          status: {
            schedules: [
              {
                schedule_id: "remote",
                state: "authorized",
                cron: "*",
                timezone: "UTC",
                environment: "prod",
                next_run_at: "2026-01-16T00:00:00Z",
              },
            ],
            inbound_hooks: [
              { inbound_hook_id: "h", slug: "hook", state: "authorized", environment: "prod" },
            ],
          },
          authorities: [authority({ execution_environment: "prod" })],
        }),
      ).triggers,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "remote", environment: "prod" }),
        expect.objectContaining({ kind: "hook", slug: "hook" }),
        expect.objectContaining({ id: "local", environment: "dev" }),
      ]),
    );
  });

  test("projects schedules and computes paused resume actions exactly", () => {
    const paused = automationState(
      input({
        schedules: [
          { id: "dev", cron: "0 * * * *", timezone: "UTC", execution_mode: "dev", paused: true },
          {
            id: "prod",
            cron: "30 * * * *",
            timezone: "Europe/Berlin",
            execution_mode: "prod",
            paused: true,
          },
        ],
        status: null,
      }),
    );
    expect(paused).toMatchObject({
      state: "paused",
      pendingEnvironments: [],
      primaryAction: { kind: "resume", scheduleIds: ["dev", "prod"] },
      secondaryAction: null,
      triggers: [
        {
          kind: "schedule",
          id: "dev",
          cron: "0 * * * *",
          timezone: "UTC",
          slug: null,
          environment: "dev",
          paused: true,
          nextRunAt: null,
        },
        {
          kind: "schedule",
          id: "prod",
          cron: "30 * * * *",
          timezone: "Europe/Berlin",
          slug: null,
          environment: "prod",
          paused: true,
          nextRunAt: null,
        },
      ],
    });
  });

  test("does not include an empty schedule id in a resume request", () => {
    expect(
      automationState(
        input({
          schedules: [{ id: "", cron: "*", timezone: "UTC", execution_mode: "dev", paused: true }],
          status: null,
        }),
      ).primaryAction,
    ).toBeNull();
  });

  test("merges verified schedules, unverified local schedules, and hooks without duplicates", () => {
    const state = automationState(
      input({
        schedules: [
          { id: "remote", cron: "old", timezone: "UTC", execution_mode: "dev", paused: false },
          { id: "local", cron: "local", timezone: "UTC", execution_mode: "dev", paused: false },
        ],
        status: {
          schedules: [
            {
              schedule_id: "remote",
              state: "paused",
              cron: "new",
              timezone: "Europe/Berlin",
              environment: "prod",
              next_run_at: "2026-01-16T00:00:00Z",
            },
          ],
          inbound_hooks: [
            {
              inbound_hook_id: "h",
              slug: "orders",
              state: "approval_required",
              environment: "prod",
            },
          ],
        },
      }),
    );
    expect(state.triggers).toEqual([
      {
        kind: "schedule",
        id: "remote",
        cron: "new",
        timezone: "Europe/Berlin",
        slug: null,
        environment: "prod",
        paused: true,
        nextRunAt: "2026-01-16T00:00:00Z",
      },
      {
        kind: "schedule",
        id: "local",
        cron: "local",
        timezone: "UTC",
        slug: null,
        environment: "dev",
        paused: false,
        nextRunAt: null,
      },
      {
        kind: "hook",
        id: null,
        cron: null,
        timezone: null,
        slug: "orders",
        environment: "prod",
        paused: false,
        nextRunAt: null,
      },
    ]);
  });

  test("materializes invalid, prepared, repair, inactive, grant, and manual contracts", () => {
    expect(automationState(input({ workflow: { invalid: true } }))).toMatchObject({
      state: "invalid",
      pendingEnvironments: [],
      facts: { version: null, inactive: false, blockedStep: null },
      primaryAction: { kind: "repair", via: "chat", stepId: null },
      secondaryAction: null,
    });
    expect(
      automationState(
        input({
          workflow: { lifecycle: "active", current_version_id: "a", draft_version_id: "d" },
          draft: { version_id: "d", version: 7 },
          schedules: [
            { id: "s", cron: "*", timezone: "UTC", execution_mode: "prod", paused: false },
          ],
        }),
      ),
    ).toMatchObject({
      state: "apply",
      facts: { preparedVersion: 7 },
      pendingEnvironments: ["prod"],
      primaryAction: { kind: "apply" },
    });
    expect(
      automationState(
        input({
          diagnosis: {
            is_current: true,
            diagnoses: [{ subject: { step_id: "needs-input" }, remedy_kind: "prepare" }],
          },
        }),
      ),
    ).toMatchObject({
      state: "repair",
      facts: { blockedStep: "needs-input" },
      primaryAction: { kind: "repair", via: "prepare", stepId: "needs-input" },
    });
    expect(
      automationState(input({ workflow: { lifecycle: "draft", current_version_id: "a" } })),
    ).toMatchObject({ state: "manual", facts: { inactive: true }, primaryAction: null });
    expect(
      automationState(
        input({
          schedules: [
            { id: "s", cron: "*", timezone: "UTC", execution_mode: "dev", paused: false },
          ],
          authorities: [],
        }),
      ),
    ).toMatchObject({
      state: "grant",
      primaryAction: { kind: "grant" },
      pendingEnvironments: ["dev"],
    });
    expect(automationState(input())).toMatchObject({
      state: "manual",
      facts: { inactive: false },
      primaryAction: { kind: "grant" },
    });
  });

  test("projects approved grant facts and extension action", () => {
    const state = automationState(
      input({
        authorities: [
          authority({
            execution_environment: "dev",
            valid_until: "2026-01-16T00:00:00.000Z",
            remaining_runs: 1,
            max_runs: 10,
            reserved_runs: 3,
          }),
        ],
      }),
    );
    expect(state).toMatchObject({
      state: "approved",
      pendingEnvironments: [],
      primaryAction: { kind: "view" },
      secondaryAction: { kind: "extend" },
      facts: {
        version: 1,
        validUntil: "2026-01-16T00:00:00.000Z",
        runsLeft: 1,
        runsMax: 10,
        runsSoFar: 3,
        untilRevoked: false,
      },
    });
  });

  test("retains a never-expiring grant and separates additional live grants", () => {
    const first = authority({
      valid_until: null,
      remaining_runs: null,
      max_runs: null,
      reserved_runs: 0,
    });
    const second = authority({ execution_environment: "prod" });
    const state = automationState(input({ authorities: [first, second] }));
    expect(state).toMatchObject({
      state: "approved",
      grant: first,
      alsoValid: [second],
      history: [],
      facts: { validUntil: null, runsLeft: null, runsMax: null, runsSoFar: 0, untilRevoked: true },
      primaryAction: { kind: "view" },
      secondaryAction: null,
    });
  });

  test("makes each unread or unavailable input a distinct unknown state", () => {
    for (const overrides of [
      { authorities: null },
      { schedules: null, status: null },
      { unanswered: { status: false, diagnosis: true } },
      {
        status: {
          schedules: [
            {
              schedule_id: "s",
              state: "verification_unavailable" as const,
              cron: "*",
              timezone: "UTC",
              environment: "dev" as const,
              next_run_at: null,
            },
          ],
          inbound_hooks: [],
        },
      },
    ]) {
      expect(automationState(input(overrides)).state).toBe("unknown");
    }
  });

  test("uses row-driven repair and requires production verification for an active hidden hook", () => {
    const repaired = automationState(
      input({
        status: {
          schedules: [
            {
              schedule_id: "s",
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
    );
    expect(repaired).toMatchObject({
      state: "repair",
      facts: { blockedStep: null },
      primaryAction: { kind: "repair", via: "chat", stepId: null },
    });

    const verifiedHook = automationState(
      input({
        workflow: { lifecycle: "active", current_version_id: "active", webhooks_active: 1 },
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
        authorities: [authority({ execution_environment: "prod" })],
      }),
    );
    expect(verifiedHook).toMatchObject({ state: "approved", primaryAction: { kind: "view" } });
  });

  test("keeps repair precedence, current-review routing, and live-grant secondary action", () => {
    const currentReview = automationState(
      input({
        authorities: [authority()],
        diagnosis: {
          is_current: true,
          diagnoses: [
            {
              subject: { step_id: "blocked" },
              fixer: { kind: "fix" },
              candidate_id: "c",
              remedy_kind: "x",
            },
          ],
        },
      }),
    );
    expect(currentReview).toMatchObject({
      state: "repair",
      facts: { blockedStep: "blocked" },
      primaryAction: { kind: "repair", via: "review", stepId: "blocked" },
      secondaryAction: { kind: "view" },
    });
  });

  test("distinguishes listed hooks, an unverified hidden hook, and expired history", () => {
    const listedHook = automationState(
      input({
        workflow: { lifecycle: "active", current_version_id: "active", webhooks_active: 1 },
        status: {
          schedules: [],
          inbound_hooks: [
            { inbound_hook_id: "hook-1", slug: "orders", state: "authorized", environment: "prod" },
          ],
        },
        authorities: [authority({ execution_environment: "prod" })],
      }),
    );
    expect(listedHook.triggers).toContainEqual(
      expect.objectContaining({ kind: "hook", slug: "orders", environment: "prod" }),
    );
    expect(listedHook.state).toBe("approved");

    const hiddenHook = automationState(
      input({
        workflow: { lifecycle: "active", current_version_id: "active", webhooks_active: 1 },
        status: {
          schedules: [
            {
              schedule_id: "dev-schedule",
              state: "authorized",
              cron: "0 * * * *",
              timezone: "UTC",
              environment: "dev",
              next_run_at: null,
            },
          ],
          inbound_hooks: [],
        },
        authorities: [authority({ execution_environment: "prod" })],
      }),
    );
    expect(hiddenHook.state).toBe("unknown");
    expect(hiddenHook.grant).toBeNull();

    const approvalHistory = automationState(
      input({
        authorities: [
          authority({ execution_environment: "prod" }),
          authority({ execution_environment: "dev", valid_until: "2020-01-01T00:00:00.000Z" }),
        ],
      }),
    );
    expect(approvalHistory.grant?.execution_environment).toBe("prod");
    expect(approvalHistory.history).toEqual([
      expect.objectContaining({
        execution_environment: "dev",
        valid_until: "2020-01-01T00:00:00.000Z",
      }),
    ]);
  });
});
