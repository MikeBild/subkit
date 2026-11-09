import { describe, expect, test } from "bun:test";
import { authority, input, NOW } from "./workflow-automation.test-helpers.ts";
import {
  automationEnvironmentDecision,
  automationState,
  grantNeedsExtension,
} from "./workflow-automation.ts";

describe("workflow automation boundary contracts", () => {
  test("keeps verified and local schedules disjoint, and classifies same-environment sources", () => {
    const local = {
      id: "local",
      cron: "local",
      timezone: "UTC",
      execution_mode: "dev" as const,
      paused: false,
    };
    const verified = {
      schedule_id: "verified",
      state: "authorized" as const,
      cron: "remote",
      timezone: "UTC",
      environment: "prod" as const,
      next_run_at: null,
    };
    expect(
      automationState(
        input({
          schedules: [local, { ...local, id: "verified" }],
          status: { schedules: [verified], inbound_hooks: [] },
        }),
      ).triggers,
    ).toEqual([
      expect.objectContaining({ id: "verified", cron: "remote" }),
      expect.objectContaining({ id: "local", cron: "local" }),
    ]);
    expect(
      automationEnvironmentDecision(
        input({
          status: {
            schedules: [{ ...verified, state: "approval_required" }],
            inbound_hooks: [
              {
                inbound_hook_id: "hook",
                slug: "hook",
                state: "approval_required",
                environment: "prod",
              },
            ],
          },
        }),
      ),
    ).toEqual({ environment: "prod", reason: "schedule" });
  });

  test("retains actionable hooks and hidden hooks as production approval sources", () => {
    const hookStatus = {
      schedules: [],
      inbound_hooks: [
        {
          inbound_hook_id: "hook",
          slug: "hook",
          state: "approval_required" as const,
          environment: "prod" as const,
        },
      ],
    };
    expect(automationEnvironmentDecision(input({ status: hookStatus }))).toEqual({
      environment: "prod",
      reason: "inbound_hook",
    });
    expect(
      automationState(
        input({
          workflow: { lifecycle: "active", current_version_id: "v", webhooks_active: 1 },
          schedules: [],
          status: null,
          authorities: [],
        }),
      ),
    ).toMatchObject({ state: "grant", environment: "prod", pendingEnvironments: ["prod"] });
    expect(
      automationEnvironmentDecision(
        input({
          workflow: { lifecycle: "active", current_version_id: "v", webhooks_active: 1 },
          schedules: [],
          status: null,
          authorities: [],
        }),
      ),
    ).toEqual({ environment: "prod", reason: "inbound_hook" });
  });

  test("keeps a pending production hook ahead of an actionable development schedule", () => {
    const pending = input({
      status: {
        schedules: [
          {
            schedule_id: "dev",
            state: "approval_required",
            cron: "*",
            timezone: "UTC",
            environment: "dev",
            next_run_at: null,
          },
        ],
        inbound_hooks: [
          {
            inbound_hook_id: "prod-hook",
            slug: "prod-hook",
            state: "approval_required",
            environment: "prod",
          },
        ],
      },
      authorities: [],
    });
    expect(automationEnvironmentDecision(pending)).toEqual({
      environment: "prod",
      reason: "inbound_hook",
    });
    const state = automationState(pending);
    expect(state).toMatchObject({
      state: "grant",
      environment: "prod",
      pendingEnvironments: ["prod", "dev"],
      primaryAction: { kind: "grant" },
    });
  });

  test("does not infer uncovered starts when status verification is present", () => {
    const state = automationState(
      input({
        schedules: [
          { id: "prod-local", cron: "*", timezone: "UTC", execution_mode: "prod", paused: false },
        ],
        status: {
          schedules: [
            {
              schedule_id: "dev-verified",
              state: "approval_required",
              cron: "*",
              timezone: "UTC",
              environment: "dev",
              next_run_at: null,
            },
          ],
          inbound_hooks: [],
        },
        authorities: [],
      }),
    );
    expect(state).toMatchObject({ environment: "dev", pendingEnvironments: ["dev"] });
  });

  test("keeps authority absence readable while a local start is present", () => {
    expect(
      automationState(
        input({
          authorities: null,
          status: null,
          schedules: [
            { id: "dev", cron: "*", timezone: "UTC", execution_mode: "dev", paused: false },
          ],
        }),
      ),
    ).toMatchObject({
      state: "unknown",
      environment: "dev",
      grant: null,
      alsoValid: [],
      history: [],
    });
  });

  test("keeps hidden-hook verification distinct from an unauthorized production row", () => {
    expect(
      automationState(
        input({
          workflow: { lifecycle: "active", current_version_id: "v", webhooks_active: 1 },
          status: {
            schedules: [
              {
                schedule_id: "prod",
                state: "approval_required",
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
      ).state,
    ).toBe("grant");
  });

  test("does not let a paused production row verify an omitted active hook", () => {
    expect(
      automationState(
        input({
          workflow: { lifecycle: "active", current_version_id: "v", webhooks_active: 1 },
          status: {
            schedules: [
              {
                schedule_id: "dev",
                state: "authorized",
                cron: "*",
                timezone: "UTC",
                environment: "dev",
                next_run_at: null,
              },
              {
                schedule_id: "prod-paused",
                state: "paused",
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
      ).state,
    ).toBe("unknown");
  });

  test("keeps inactive workflows out of pending approval environments", () => {
    expect(
      automationState(input({ workflow: { lifecycle: "draft", current_version_id: "v" } })),
    ).toMatchObject({ state: "manual", pendingEnvironments: [] });
  });

  test("includes production in prepared environments only for an active hidden hook", () => {
    const prepared = { lifecycle: "active", current_version_id: "v", draft_version_id: "d" };
    const draft = { version_id: "d", version: 1 };
    const schedules = [
      { id: "dev", cron: "*", timezone: "UTC", execution_mode: "dev" as const, paused: false },
    ];
    expect(
      automationState(
        input({ workflow: prepared, draft, schedules, status: null, authorities: [] }),
      ).pendingEnvironments,
    ).toEqual(["dev"]);
    expect(
      automationState(
        input({
          workflow: { ...prepared, webhooks_active: 1 },
          draft,
          schedules,
          status: null,
          authorities: [],
        }),
      ).pendingEnvironments,
    ).toEqual(["prod", "dev"]);
  });

  test("keeps unshown approval collections and diagnostic fallback explicit", () => {
    const historical = authority({ valid_until: "2020-01-01T00:00:00Z" });
    expect(
      automationState(
        input({
          schedules: [
            { id: "s", cron: "*", timezone: "UTC", execution_mode: "dev", paused: false },
          ],
          status: null,
          authorities: [historical],
        }),
      ),
    ).toMatchObject({ state: "grant", grant: null, alsoValid: [], history: [historical] });
    expect(
      automationState(
        input({
          diagnosis: {
            is_current: undefined as unknown as boolean,
            diagnoses: [
              {
                subject: { step_id: "fallback" },
                fixer: true,
                candidate_id: "candidate",
                remedy_kind: "manual",
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ primaryAction: { kind: "repair", via: "chat", stepId: "fallback" } });
  });

  test("keeps exact quota and temporal extension thresholds distinct", () => {
    const inTwoDays = "2026-01-17T12:00:00.000Z";
    const inThreeDays = "2026-01-18T12:00:00.000Z";
    expect(
      grantNeedsExtension(
        authority({ valid_until: inTwoDays, remaining_runs: null, max_runs: null }),
        NOW,
      ),
    ).toBe(true);
    expect(
      grantNeedsExtension(
        authority({ valid_until: inThreeDays, remaining_runs: null, max_runs: null }),
        NOW,
      ),
    ).toBe(false);
    expect(
      grantNeedsExtension(authority({ valid_until: null, remaining_runs: 0, max_runs: 1 }), NOW),
    ).toBe(true);
    expect(
      grantNeedsExtension(authority({ valid_until: null, remaining_runs: 1, max_runs: 10 }), NOW),
    ).toBe(false);
    expect(
      grantNeedsExtension(authority({ valid_until: null, remaining_runs: 9, max_runs: 10 }), NOW),
    ).toBe(false);
    expect(
      grantNeedsExtension(authority({ valid_until: null, remaining_runs: 1, max_runs: -10 }), NOW),
    ).toBe(false);
    expect(
      grantNeedsExtension(
        authority({ valid_until: "invalid", remaining_runs: 0, max_runs: 10 }),
        NOW,
      ),
    ).toBe(true);
  });

  test("uses authority fallback only when no trigger supplies an environment", () => {
    expect(
      automationEnvironmentDecision(
        input({
          schedules: [],
          status: { schedules: [], inbound_hooks: [] },
          authorities: [
            authority({ execution_environment: "prod", revoked_at: "x" }),
            authority({ execution_environment: "dev", valid_until: "2026-01-15T12:00:00.000Z" }),
          ],
        }),
      ),
    ).toEqual({ environment: "prod", reason: "existing_approval" });
    expect(
      automationEnvironmentDecision(
        input({
          schedules: [
            { id: "p", cron: "*", timezone: "UTC", execution_mode: "prod", paused: true },
          ],
          status: { schedules: [], inbound_hooks: [] },
          authorities: [authority({ execution_environment: "dev" })],
        }),
      ),
    ).toEqual({ environment: "prod", reason: "schedule" });
  });

  test("keeps environment selection ordered and identifies the source that requires approval", () => {
    const schedule = {
      schedule_id: "s",
      state: "approval_required" as const,
      cron: "*",
      timezone: "UTC",
      environment: "prod" as const,
      next_run_at: null,
    };
    const hook = {
      inbound_hook_id: "h",
      slug: "orders",
      state: "approval_required" as const,
      environment: "prod" as const,
    };
    expect(
      automationEnvironmentDecision(
        input({ status: { schedules: [schedule], inbound_hooks: [hook] } }),
      ),
    ).toEqual({
      environment: "prod",
      reason: "schedule",
    });
    expect(
      automationEnvironmentDecision(input({ status: { schedules: [], inbound_hooks: [hook] } })),
    ).toEqual({
      environment: "prod",
      reason: "inbound_hook",
    });
    expect(
      automationEnvironmentDecision(
        input({
          status: { schedules: [schedule], inbound_hooks: [] },
          schedules: [
            { id: "d", cron: "*", timezone: "UTC", execution_mode: "dev", paused: false },
          ],
        }),
      ),
    ).toEqual({ environment: "prod", reason: "schedule" });
  });

  test("does not ask for approval for covered starts, but does for every uncovered source", () => {
    const started = (environment: "dev" | "prod", paused = false) => ({
      id: environment,
      cron: "*",
      timezone: "UTC",
      execution_mode: environment,
      paused,
    });
    expect(
      automationState(
        input({
          schedules: [started("prod")],
          status: null,
          authorities: [authority({ execution_environment: "prod" })],
        }),
      ),
    ).toMatchObject({
      state: "approved",
      pendingEnvironments: [],
      primaryAction: { kind: "view" },
    });
    expect(
      automationState(
        input({
          schedules: [started("prod")],
          status: null,
          authorities: [authority({ execution_environment: "prod", ready_for_new_run: false })],
        }),
      ),
    ).toMatchObject({
      state: "grant",
      pendingEnvironments: ["prod"],
      primaryAction: { kind: "grant" },
    });
    expect(
      automationState(
        input({
          schedules: [started("dev"), started("prod")],
          status: null,
          authorities: [authority({ execution_environment: "dev" })],
        }),
      ),
    ).toMatchObject({ state: "grant", pendingEnvironments: ["prod"] });
    expect(
      automationState(input({ schedules: [started("dev", true)], status: null, authorities: [] })),
    ).toMatchObject({
      state: "paused",
      primaryAction: { kind: "resume", scheduleIds: ["dev"] },
    });
  });
});
