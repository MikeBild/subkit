import { describe, expect, test } from "bun:test";
import { authority, input } from "./workflow-automation.test-helpers.ts";
import { automationEnvironmentDecision, automationState } from "./workflow-automation.ts";

describe("workflow automation boundary contracts", () => {
  test("preserves exact status-row semantics across pending, authorized, and paused rows", () => {
    const row = (
      state:
        | "paused"
        | "authorized"
        | "approval_required"
        | "activation_required"
        | "verification_unavailable",
    ) => ({
      schedule_id: "s",
      state,
      cron: "*",
      timezone: "UTC",
      environment: "dev" as const,
      next_run_at: null,
    });
    expect(
      automationState(
        input({ status: { schedules: [row("paused")], inbound_hooks: [] }, schedules: [] }),
      ),
    ).toMatchObject({
      state: "paused",
      primaryAction: { kind: "resume", scheduleIds: ["s"] },
    });
    expect(
      automationState(
        input({
          status: { schedules: [row("authorized")], inbound_hooks: [] },
          authorities: [authority()],
        }),
      ),
    ).toMatchObject({
      state: "approved",
      primaryAction: { kind: "view" },
    });
    expect(
      automationState(
        input({
          status: { schedules: [row("approval_required")], inbound_hooks: [] },
          authorities: [],
        }),
      ),
    ).toMatchObject({
      state: "grant",
      pendingEnvironments: ["dev"],
      primaryAction: { kind: "grant" },
    });
    expect(
      automationState(
        input({
          status: { schedules: [row("activation_required")], inbound_hooks: [] },
          authorities: [],
        }),
      ),
    ).toMatchObject({
      state: "grant",
      pendingEnvironments: ["dev"],
    });
    expect(
      automationState(
        input({ status: { schedules: [row("verification_unavailable")], inbound_hooks: [] } }),
      ),
    ).toMatchObject({ state: "unknown" });
  });

  test("uses verified row data over local data and keeps every paused source paused", () => {
    const state = automationState(
      input({
        schedules: [
          { id: "same", cron: "local", timezone: "UTC", execution_mode: "dev", paused: false },
        ],
        status: {
          schedules: [
            {
              schedule_id: "same",
              state: "paused",
              cron: "remote",
              timezone: "CET",
              environment: "prod",
              next_run_at: "next",
            },
          ],
          inbound_hooks: [
            { inbound_hook_id: "h", slug: "h", state: "paused", environment: "prod" },
          ],
        },
      }),
    );
    expect(state).toMatchObject({
      state: "paused",
      primaryAction: { kind: "resume", scheduleIds: ["same"] },
      triggers: [
        {
          id: "same",
          cron: "remote",
          timezone: "CET",
          environment: "prod",
          paused: true,
          nextRunAt: "next",
        },
        { kind: "hook", slug: "h", paused: true },
      ],
    });
  });

  test("filters pending hooks precisely and keeps a running dev trigger ahead of a paused prod trigger", () => {
    const hook = (state: "paused" | "authorized" | "approval_required") => ({
      inbound_hook_id: state,
      slug: state,
      state,
      environment: "prod" as const,
    });
    expect(
      automationEnvironmentDecision(
        input({
          status: { schedules: [], inbound_hooks: [hook("paused"), hook("authorized")] },
          authorities: [],
        }),
      ),
    ).toEqual({ environment: "prod", reason: "inbound_hook" });
    expect(
      automationEnvironmentDecision(
        input({
          status: { schedules: [], inbound_hooks: [hook("paused"), hook("approval_required")] },
          authorities: [],
        }),
      ),
    ).toEqual({ environment: "prod", reason: "inbound_hook" });
    expect(
      automationEnvironmentDecision(
        input({
          schedules: [
            { id: "p", cron: "*", timezone: "UTC", execution_mode: "prod", paused: true },
            { id: "d", cron: "*", timezone: "UTC", execution_mode: "dev", paused: false },
          ],
          status: { schedules: [], inbound_hooks: [] },
          authorities: [],
        }),
      ),
    ).toEqual({ environment: "dev", reason: "schedule" });
  });

  test("gives an actionable pending row priority over otherwise-running production rows", () => {
    expect(
      automationEnvironmentDecision(
        input({
          status: {
            schedules: [
              {
                schedule_id: "prod",
                state: "authorized",
                cron: "*",
                timezone: "UTC",
                environment: "prod",
                next_run_at: null,
              },
              {
                schedule_id: "dev",
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
      ),
    ).toEqual({ environment: "dev", reason: "schedule" });
  });

  test("excludes paused and authorized hooks from pending environments", () => {
    const schedule = {
      schedule_id: "prod",
      state: "authorized" as const,
      cron: "*",
      timezone: "UTC",
      environment: "prod" as const,
      next_run_at: null,
    };
    for (const state of ["paused", "authorized"] as const) {
      expect(
        automationEnvironmentDecision(
          input({
            status: {
              schedules: [schedule],
              inbound_hooks: [{ inbound_hook_id: state, slug: state, state, environment: "prod" }],
            },
            authorities: [],
          }),
        ),
      ).toEqual({ environment: "prod", reason: "schedule" });
    }
  });

  test("keeps a pending production hook distinct from a paused development schedule", () => {
    expect(
      automationState(
        input({
          schedules: [
            { id: "dev", cron: "*", timezone: "UTC", execution_mode: "dev", paused: true },
          ],
          status: {
            schedules: [
              {
                schedule_id: "dev",
                state: "paused",
                cron: "*",
                timezone: "UTC",
                environment: "dev",
                next_run_at: null,
              },
            ],
            inbound_hooks: [
              {
                inbound_hook_id: "prod",
                slug: "prod",
                state: "approval_required",
                environment: "prod",
              },
            ],
          },
          authorities: [],
        }),
      ),
    ).toMatchObject({
      state: "grant",
      environment: "prod",
      pendingEnvironments: ["prod"],
      primaryAction: { kind: "grant" },
    });
  });

  test("derives uncovered sources only from live schedules and active hidden hooks", () => {
    expect(
      automationState(
        input({
          schedules: [
            { id: "paused-prod", cron: "*", timezone: "UTC", execution_mode: "prod", paused: true },
            { id: "running-dev", cron: "*", timezone: "UTC", execution_mode: "dev", paused: false },
          ],
          status: null,
          authorities: [],
        }),
      ),
    ).toMatchObject({ state: "grant", environment: "dev", pendingEnvironments: ["dev"] });
    expect(
      automationState(
        input({
          workflow: { lifecycle: "active", current_version_id: "v", webhooks_active: 1 },
          schedules: [
            { id: "running-dev", cron: "*", timezone: "UTC", execution_mode: "dev", paused: false },
          ],
          status: null,
          authorities: [],
        }),
      ),
    ).toMatchObject({ state: "grant", environment: "prod", pendingEnvironments: ["prod", "dev"] });
  });

  test("handles hook-only pauses and partial authorization without manufacturing a resume or approval", () => {
    expect(
      automationState(
        input({
          status: {
            schedules: [],
            inbound_hooks: [
              { inbound_hook_id: "h", slug: "h", state: "paused", environment: "prod" },
            ],
          },
        }),
      ),
    ).toMatchObject({ state: "paused", primaryAction: null, pendingEnvironments: [] });
    expect(
      automationState(
        input({
          status: {
            schedules: [
              {
                schedule_id: "one",
                state: "authorized",
                cron: "*",
                timezone: "UTC",
                environment: "dev",
                next_run_at: null,
              },
              {
                schedule_id: "two",
                state: "approval_required",
                cron: "*",
                timezone: "UTC",
                environment: "dev",
                next_run_at: null,
              },
            ],
            inbound_hooks: [],
          },
          authorities: [authority()],
        }),
      ),
    ).toMatchObject({ state: "grant", grant: null, primaryAction: { kind: "grant" } });
  });
});
