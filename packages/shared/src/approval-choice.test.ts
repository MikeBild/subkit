import { describe, expect, test } from "bun:test";
import {
  type ApprovalPreviewLike,
  approvalChoice,
  approvalRemedy,
  type EnvironmentAssessments,
  type EnvironmentBlock,
  recommendEnvironment,
} from "./approval-choice.ts";
import {
  automationEnvironment,
  automationEnvironmentDecision,
  type ScheduleLike,
  type WorkflowAuthority,
} from "./workflow-automation.ts";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const CONNECTOR = "00000000-0000-4000-8000-000000000001";

const block = (code: EnvironmentBlock["code"], step_id = "send"): EnvironmentBlock => ({
  code,
  step_id,
  connector_id: CONNECTOR,
  connector_name: "Support Admin",
});

const assess = (dev: EnvironmentBlock[], prod: EnvironmentBlock[]): EnvironmentAssessments => ({
  dev: { possible: dev.length === 0, reasons: dev },
  prod: { possible: prod.length === 0, reasons: prod },
});

const schedule = (execution_mode: "dev" | "prod", paused = false): ScheduleLike => ({
  id: `schedule-${execution_mode}`,
  cron: "0 8 * * *",
  timezone: "UTC",
  execution_mode,
  paused,
});

const authority = (execution_environment: "dev" | "prod"): WorkflowAuthority => ({
  execution_environment,
  active_version: true,
  ready_for_new_run: true,
  state: "approved",
  valid_from: "2026-02-01T00:00:00.000Z",
  valid_until: "2026-04-01T00:00:00.000Z",
  revoked_at: null,
  remaining_runs: 5,
  max_runs: 10,
  reserved_runs: 5,
});

const context = (input: {
  schedules?: ScheduleLike[];
  webhooks_active?: number;
  authorities?: WorkflowAuthority[];
}) =>
  automationEnvironmentDecision({
    workflow: { webhooks_active: input.webhooks_active ?? 0 },
    schedules: input.schedules ?? [],
    status: null,
    authorities: input.authorities ?? [],
    now: NOW,
  });

const preview = (environments: EnvironmentAssessments, ctx = context({})): ApprovalPreviewLike => ({
  environments,
  recommended_environment: recommendEnvironment(ctx, environments),
});

describe("environment context decision", () => {
  test("names the trigger that decides the environment", () => {
    expect(context({})).toBeNull();
    expect(context({ schedules: [schedule("prod")] })).toEqual({
      environment: "prod",
      reason: "schedule",
    });
    expect(context({ webhooks_active: 1 })).toEqual({
      environment: "prod",
      reason: "inbound_hook",
    });
    expect(context({ schedules: [schedule("dev", true)] })).toEqual({
      environment: "dev",
      reason: "schedule",
    });
    expect(context({ authorities: [authority("prod")] })).toEqual({
      environment: "prod",
      reason: "existing_approval",
    });
  });

  test("keeps the environment the automation panel already chooses", () => {
    const base = { workflow: {}, schedules: [], status: null, now: NOW };
    expect(automationEnvironment({ ...base, authorities: null })).toBe("dev");
    expect(automationEnvironment({ ...base, authorities: [], connectorEnvironment: "prod" })).toBe(
      "prod",
    );
    expect(automationEnvironment({ ...base, schedules: [schedule("prod")], authorities: [] })).toBe(
      "prod",
    );
  });
});

describe("recommended environment", () => {
  test("a manual workflow whose connector exists only in Test is approved in Test", () => {
    expect(recommendEnvironment(null, assess([], [block("connector_missing")]))).toEqual({
      environment: "dev",
      reason: "only_possible",
    });
  });

  test("a manual workflow whose connector exists only in Production is approved there", () => {
    expect(recommendEnvironment(null, assess([block("connector_missing")], []))).toEqual({
      environment: "prod",
      reason: "only_possible",
    });
  });

  test("a manual workflow possible in both starts in Test", () => {
    expect(recommendEnvironment(null, assess([], []))).toEqual({
      environment: "dev",
      reason: "started_manually",
    });
  });

  test("a schedule in Production decides when Production is possible", () => {
    expect(
      recommendEnvironment(context({ schedules: [schedule("prod")] }), assess([], [])),
    ).toEqual({ environment: "prod", reason: "schedule" });
  });

  test("an impossible context environment yields the possible one", () => {
    expect(
      recommendEnvironment(
        context({ schedules: [schedule("prod")] }),
        assess([], [block("connector_missing")]),
      ),
    ).toEqual({ environment: "dev", reason: "only_possible" });
  });

  test("nothing is recommended when neither environment is possible", () => {
    expect(
      recommendEnvironment(
        context({ webhooks_active: 1 }),
        assess([block("connector_without_sign_in")], [block("connector_missing")]),
      ),
    ).toEqual({ environment: null, reason: "none_possible" });
  });
});

describe("approval choice", () => {
  test("only one possible environment is a single answer", () => {
    expect(approvalChoice(preview(assess([], [block("connector_missing")])))).toEqual({
      kind: "single",
      environment: "dev",
      reason: "only_possible",
    });
  });

  test("both possible with a Production schedule is a single answer", () => {
    expect(
      approvalChoice(preview(assess([], []), context({ schedules: [schedule("prod")] }))),
    ).toEqual({ kind: "single", environment: "prod", reason: "schedule" });
  });

  test("both possible with an existing approval keeps that environment", () => {
    expect(
      approvalChoice(preview(assess([], []), context({ authorities: [authority("prod")] }))),
    ).toEqual({ kind: "single", environment: "prod", reason: "existing_approval" });
  });

  test("both possible without context is a real choice recommending Test", () => {
    expect(approvalChoice(preview(assess([], [])))).toEqual({
      kind: "choice",
      recommended: "dev",
      options: [
        { environment: "dev" as const, possible: true },
        { environment: "prod" as const, possible: true },
      ],
    });
  });

  test("none possible lists every reason with its environment", () => {
    expect(
      approvalChoice(
        preview(assess([block("connector_without_sign_in")], [block("connector_missing")])),
      ),
    ).toEqual({
      kind: "none",
      reasons: [
        { ...block("connector_without_sign_in"), environment: "dev" },
        { ...block("connector_missing"), environment: "prod" },
      ],
    });
  });
});

describe("approval remedy", () => {
  test("a connector without sign-in is opened", () => {
    expect(
      approvalRemedy([
        { ...block("connector_without_sign_in"), environment: "dev" },
        { ...block("connector_missing"), environment: "prod" },
      ]),
    ).toEqual({
      kind: "open_connector",
      environment: "dev",
      step_id: "send",
      connector_id: CONNECTOR,
    });
  });

  test("a connector that needs signing in again asks for sign-in", () => {
    expect(
      approvalRemedy([
        { ...block("connector_missing", "fetch"), environment: "prod" },
        { ...block("connector_needs_sign_in_again"), environment: "prod" },
      ]),
    ).toEqual({
      kind: "sign_in_again",
      environment: "prod",
      step_id: "send",
      connector_id: CONNECTOR,
    });
  });

  test("a missing or switched off connector is opened", () => {
    expect(approvalRemedy([{ ...block("connector_switched_off"), environment: "prod" }])).toEqual({
      kind: "open_connector",
      environment: "prod",
      step_id: "send",
      connector_id: CONNECTOR,
    });
    expect(approvalRemedy([{ ...block("connector_missing"), environment: "dev" }])).toEqual({
      kind: "open_connector",
      environment: "dev",
      step_id: "send",
      connector_id: CONNECTOR,
    });
  });

  test("the preferred environment wins over the one with fewer reasons", () => {
    expect(
      approvalRemedy(
        [
          { ...block("connector_without_sign_in"), environment: "dev" },
          { ...block("connector_missing", "a"), environment: "prod" },
          { ...block("connector_missing", "b"), environment: "prod" },
        ],
        "prod",
      ),
    ).toMatchObject({ kind: "open_connector", environment: "prod", step_id: "a" });
  });

  test("no reasons have no remedy", () => {
    expect(approvalRemedy([])).toBeNull();
  });
});

describe("an engine without environment assessments", () => {
  test("offers both environments and recommends the requested one", () => {
    const expected = (recommended: "dev" | "prod") => ({
      kind: "choice" as const,
      recommended,
      options: [
        { environment: "dev" as const, possible: true },
        { environment: "prod" as const, possible: true },
      ],
    });
    expect(approvalChoice({})).toEqual(expected("dev"));
    expect(approvalChoice({}, "prod")).toEqual(expected("prod"));
    expect(
      approvalChoice(
        { recommended_environment: { environment: "dev", reason: "schedule" } },
        "prod",
      ),
    ).toEqual(expected("prod"));
    expect(approvalChoice({ environments: assess([], []) }, "prod")).toEqual(expected("prod"));
  });

  test("a partial assessment does not throw", () => {
    const partial = { dev: { possible: true, reasons: [] } } as unknown as EnvironmentAssessments;
    expect(
      approvalChoice({
        environments: partial,
        recommended_environment: { environment: "prod", reason: "schedule" },
      }),
    ).toMatchObject({ kind: "none" });
  });
});
