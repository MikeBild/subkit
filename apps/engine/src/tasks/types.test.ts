import { describe, expect, test } from "bun:test";
import type { z } from "@hono/zod-openapi";
import {
  TASK_ADMISSION_REASONS,
  TASK_ENVIRONMENTS,
  TASK_GRANT_BLOCK_REASONS,
  TASK_LIFECYCLES,
  TASK_PAUSED_REASONS,
  TASK_RUN_OPEN_STATES,
  TASK_RUN_STATES,
  TASK_RUN_TRIGGERS,
  TASK_RUN_WAITING_REASONS,
  TaskAdmissionReasonSchema,
  TaskBindingsSchema,
  TaskCreateInputSchema,
  TaskEnvironmentSchema,
  TaskGrantBlockReasonSchema,
  TaskGrantInputSchema,
  TaskGrantPreviewSchema,
  TaskGrantSchema,
  TaskLifecycleSchema,
  TaskPausedReasonSchema,
  TaskPlanSchema,
  TaskRunMarkerSchema,
  TaskRunSchema,
  TaskRunStateSchema,
  TaskRunTriggerSchema,
  TaskRunWaitingReasonSchema,
  TaskScheduleSchema,
  TaskSchema,
  TaskUpdateInputSchema,
} from "./index.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const AT = "2026-11-19T08:00:00.000Z";
const FINGERPRINT = "a".repeat(64);
const TRACE = "b".repeat(32);

const plan = {
  title: "Weekly report",
  goal: "Send the weekly report",
  steps: [
    {
      id: "collect",
      label: "Collect the numbers",
      criterion: {
        kind: "assessment" as const,
        description: "Numbers are complete",
        result: null,
      },
      depends_on: [],
      evidence_ids: [],
      note: null,
      progress: "open" as const,
      next_action: null,
    },
  ],
  cancelled: false,
  completion_step_id: null,
};
const bindings = {
  workflow_ids: [ID],
  connector_ids: [OTHER_ID],
  skill_slugs: ["weekly-report"],
  web_search: false,
};
const createInput = {
  name: "Weekly report",
  goal: "Send the weekly report",
  done_when: "The report is in the inbox",
  plan,
  bindings,
  environment: "prod",
};
const task = {
  id: ID,
  name: "Weekly report",
  description: null,
  category: "other",
  owner_id: OTHER_ID,
  goal: "Send the weekly report",
  done_when: "The report is in the inbox",
  plan,
  bindings,
  environment: "prod",
  schedule_cron: "0 8 * * 1",
  schedule_timezone: "Europe/Berlin",
  schedule_run_at: null,
  last_claimed_at: null,
  paused_at: null,
  paused_by: null,
  paused_reason: null,
  max_turns: 20,
  run_deadline_minutes: 240,
  fingerprint: FINGERPRINT,
  revision: 1,
  lifecycle: "active",
  created_at: AT,
  updated_at: AT,
};
const run = {
  id: ID,
  task_id: OTHER_ID,
  task_revision: 1,
  fingerprint: FINGERPRINT,
  conversation_id: null,
  trigger: "cron",
  started_by: null,
  grant_id: null,
  state: "running",
  waiting_reason: null,
  next_check_at: null,
  sleep_reason: null,
  deadline_at: AT,
  turns_used: 0,
  no_progress_count: 0,
  last_seen_turn_id: null,
  last_playbook_revision: 0,
  trace_id: TRACE,
  failure_code: null,
  result_ready_at: null,
  completed_at: null,
  completed_by: null,
  ended_at: null,
  created_at: AT,
  updated_at: AT,
};
const grant = {
  id: ID,
  task_id: OTHER_ID,
  fingerprint: FINGERPRINT,
  environment: "prod",
  valid_from: AT,
  valid_until: null,
  max_runs: null,
  reserved_runs: 0,
  created_by: ID,
  created_at: AT,
  revoked_at: null,
  revoked_by: null,
  workflow_authority_ids: [ID],
};
const marker = {
  task_id: ID,
  task_run_id: OTHER_ID,
  environment: "dev",
  workflow_ids: [ID],
  connector_ids: [],
  web_search: true,
};

function accepts(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success;
}

describe("closed value sets", () => {
  const sets: Array<
    [string, z.ZodType & { options: readonly string[] }, readonly string[], string]
  > = [
    ["environment", TaskEnvironmentSchema, ["dev", "prod"], "staging"],
    ["lifecycle", TaskLifecycleSchema, ["active", "archived"], "draft"],
    [
      "paused reason",
      TaskPausedReasonSchema,
      ["owner_request", "admin", "owner_unavailable"],
      "vacation",
    ],
    ["run trigger", TaskRunTriggerSchema, ["manual", "once", "cron"], "webhook"],
    [
      "run state",
      TaskRunStateSchema,
      ["running", "waiting", "sleeping", "result_ready", "completed", "aborted", "failed"],
      "paused",
    ],
    [
      "waiting reason",
      TaskRunWaitingReasonSchema,
      [
        "question",
        "approval",
        "no_progress",
        "budget",
        "question_expired",
        "ai_access",
        "turn_stopped",
      ],
      "deadline",
    ],
    [
      "admission reason",
      TaskAdmissionReasonSchema,
      [
        "grant_required",
        "grant_expired",
        "grant_exhausted",
        "grant_fingerprint_mismatch",
        "owner_unavailable",
        "ai_access_missing",
        "previous_run_active",
        "paused",
      ],
      "grant_revoked",
    ],
    [
      "grant block reason",
      TaskGrantBlockReasonSchema,
      ["workflow_missing", "workflow_not_active", "workflow_sensitive", "workflow_not_repeatable"],
      "workflow_slow",
    ],
  ];
  for (const [label, schema, values, outsider] of sets) {
    test(`${label} admits exactly its values`, () => {
      expect(schema.options).toEqual([...values]);
      for (const value of values) expect(accepts(schema, value)).toBe(true);
      for (const value of [outsider, "", values[0]?.toUpperCase(), null, 1])
        expect(accepts(schema, value)).toBe(false);
    });
  }

  test("the exported lists are the schema values and open states are run states", () => {
    expect(TaskEnvironmentSchema.options).toEqual([...TASK_ENVIRONMENTS]);
    expect(TaskLifecycleSchema.options).toEqual([...TASK_LIFECYCLES]);
    expect(TaskPausedReasonSchema.options).toEqual([...TASK_PAUSED_REASONS]);
    expect(TaskRunTriggerSchema.options).toEqual([...TASK_RUN_TRIGGERS]);
    expect(TaskRunStateSchema.options).toEqual([...TASK_RUN_STATES]);
    expect(TaskRunWaitingReasonSchema.options).toEqual([...TASK_RUN_WAITING_REASONS]);
    expect(TaskAdmissionReasonSchema.options).toEqual([...TASK_ADMISSION_REASONS]);
    expect(TaskGrantBlockReasonSchema.options).toEqual([...TASK_GRANT_BLOCK_REASONS]);
    expect([...TASK_RUN_OPEN_STATES]).toEqual(["running", "waiting", "sleeping"]);
  });
});

describe("bindings and plan", () => {
  test("bindings need all four fields, uuids and distinct entries", () => {
    expect(TaskBindingsSchema.parse(bindings)).toEqual(bindings);
    expect(
      accepts(TaskBindingsSchema, {
        workflow_ids: [],
        connector_ids: [],
        skill_slugs: [],
        web_search: true,
      }),
    ).toBe(true);
    for (const invalid of [
      { ...bindings, workflow_ids: ["not-a-uuid"] },
      { ...bindings, workflow_ids: [ID, ID] },
      { ...bindings, connector_ids: [OTHER_ID, OTHER_ID] },
      { ...bindings, skill_slugs: ["a", "a"] },
      { ...bindings, skill_slugs: [""] },
      { ...bindings, web_search: "yes" },
      { ...bindings, tenant_id: ID },
      { workflow_ids: [], connector_ids: [], skill_slugs: [] },
    ])
      expect(accepts(TaskBindingsSchema, invalid)).toBe(false);
  });

  test("a plan keeps the playbook step details and needs a title, a goal and one step", () => {
    expect(TaskPlanSchema.parse(plan)).toEqual(plan);
    for (const invalid of [
      { ...plan, steps: [] },
      { ...plan, title: " " },
      { ...plan, goal: "g".repeat(601) },
      { ...plan, steps: [{ id: "Collect", label: "Collect" }] },
      { ...plan, steps: [{ id: "collect" }] },
      { ...plan, cancelled: "no" },
      { ...plan, completion_step_id: undefined },
    ])
      expect(accepts(TaskPlanSchema, invalid)).toBe(false);
  });
});

describe("schedule", () => {
  const none = { schedule_cron: null, schedule_timezone: null, schedule_run_at: null };

  test("a task repeats, runs once or has no schedule", () => {
    for (const valid of [
      none,
      { ...none, schedule_cron: "0 8 * * 1", schedule_timezone: "Europe/Berlin" },
      { ...none, schedule_run_at: AT, schedule_timezone: "Europe/Berlin" },
      { ...none, schedule_run_at: "2026-11-19T09:00:00+01:00" },
    ])
      expect(accepts(TaskScheduleSchema, valid)).toBe(true);
  });

  test("cron together with a single run time, empty and malformed values are refused", () => {
    for (const invalid of [
      { ...none, schedule_cron: "0 8 * * 1", schedule_run_at: AT },
      { ...none, schedule_cron: "" },
      { ...none, schedule_timezone: "" },
      { ...none, schedule_run_at: "tomorrow" },
      { schedule_cron: null, schedule_timezone: null },
      { ...none, every: "15m" },
    ])
      expect(accepts(TaskScheduleSchema, invalid)).toBe(false);
  });
});

describe("task input and view", () => {
  test("creating fills the documented defaults", () => {
    expect<unknown>(TaskCreateInputSchema.parse(createInput)).toEqual({
      ...createInput,
      description: null,
      schedule_cron: null,
      schedule_timezone: null,
      schedule_run_at: null,
      max_turns: 10,
      run_deadline_minutes: 240,
    });
  });

  test("creating refuses tenant, owner, unknown fields and values outside the limits", () => {
    for (const invalid of [
      { ...createInput, tenant_id: ID },
      { ...createInput, owner_id: ID },
      { ...createInput, name: " " },
      { ...createInput, goal: "" },
      { ...createInput, done_when: "" },
      { ...createInput, environment: "staging" },
      { ...createInput, category: "Not A Slug" },
      { ...createInput, max_turns: 0 },
      { ...createInput, max_turns: 101 },
      { ...createInput, max_turns: 1.5 },
      { ...createInput, run_deadline_minutes: 4 },
      { ...createInput, run_deadline_minutes: 10081 },
      { ...createInput, schedule_cron: "0 8 * * 1", schedule_run_at: AT },
      { ...createInput, bindings: { ...bindings, workflow_ids: ["x"] } },
      { ...createInput, plan: { ...plan, steps: [] } },
    ])
      expect(accepts(TaskCreateInputSchema, invalid)).toBe(false);
    expect(accepts(TaskCreateInputSchema, { ...createInput, category: "reports" })).toBe(true);
    expect(accepts(TaskCreateInputSchema, { ...createInput, max_turns: 100 })).toBe(true);
    expect(accepts(TaskCreateInputSchema, { ...createInput, run_deadline_minutes: 5 })).toBe(true);
  });

  test("updating needs the revision it was based on", () => {
    expect(accepts(TaskUpdateInputSchema, { ...createInput, expected_revision: 3 })).toBe(true);
    for (const invalid of [
      createInput,
      { ...createInput, expected_revision: 0 },
      { ...createInput, expected_revision: 1.5 },
      { ...createInput, expected_revision: 1, schedule_cron: "0 8 * * 1", schedule_run_at: AT },
      { ...createInput, expected_revision: 1, tenant_id: ID },
    ])
      expect(accepts(TaskUpdateInputSchema, invalid)).toBe(false);
  });

  test("the task view carries every column but the tenant", () => {
    expect<unknown>(TaskSchema.parse(task)).toEqual(task);
    expect("tenant_id" in TaskSchema.shape).toBe(false);
    for (const invalid of [
      { ...task, fingerprint: "abc" },
      { ...task, lifecycle: "draft" },
      { ...task, paused_reason: "vacation" },
      { ...task, environment: "staging" },
      { ...task, owner_id: "someone" },
      { ...task, created_at: "yesterday" },
    ])
      expect(accepts(TaskSchema, invalid)).toBe(false);
  });
});

describe("run, grant and marker", () => {
  test("the run view admits every state and waiting reason and refuses malformed ids", () => {
    expect<unknown>(TaskRunSchema.parse(run)).toEqual(run);
    for (const state of TASK_RUN_STATES)
      expect(accepts(TaskRunSchema, { ...run, state })).toBe(true);
    for (const waiting_reason of TASK_RUN_WAITING_REASONS)
      expect(accepts(TaskRunSchema, { ...run, state: "waiting", waiting_reason })).toBe(true);
    for (const invalid of [
      { ...run, state: "paused" },
      { ...run, trigger: "webhook" },
      { ...run, waiting_reason: "tired" },
      { ...run, trace_id: "abc" },
      { ...run, fingerprint: "abc" },
      { ...run, sleep_reason: "s".repeat(201) },
      { ...run, deadline_at: null },
    ])
      expect(accepts(TaskRunSchema, invalid)).toBe(false);
  });

  test("the grant view and the grant input keep limits optional but well-formed", () => {
    expect<unknown>(TaskGrantSchema.parse(grant)).toEqual(grant);
    expect(accepts(TaskGrantSchema, { ...grant, workflow_authority_ids: ["x"] })).toBe(false);
    expect(accepts(TaskGrantSchema, { ...grant, environment: "staging" })).toBe(false);

    const input = { expected_fingerprint: FINGERPRINT, valid_until: null, max_runs: null };
    expect(TaskGrantInputSchema.parse(input)).toEqual(input);
    expect(accepts(TaskGrantInputSchema, { ...input, valid_until: AT, max_runs: 5 })).toBe(true);
    for (const invalid of [
      { ...input, expected_fingerprint: "A".repeat(64) },
      { ...input, expected_fingerprint: "a".repeat(63) },
      { ...input, max_runs: 0 },
      { ...input, max_runs: 1.5 },
      { ...input, valid_until: "soon" },
      { expected_fingerprint: FINGERPRINT, valid_until: null },
      { expected_fingerprint: FINGERPRINT, max_runs: null },
      { ...input, environment: "prod" },
    ])
      expect(accepts(TaskGrantInputSchema, invalid)).toBe(false);
  });

  test("the grant preview names each bound workflow with its effect or the reason it blocks", () => {
    const preview = {
      task_id: ID,
      fingerprint: FINGERPRINT,
      environment: "prod",
      grantable: false,
      workflows: [
        {
          workflow_id: OTHER_ID,
          workflow_version_id: null,
          name: null,
          effect_manifest_digest: null,
          effect_manifest: null,
          blocked_reason: "workflow_missing",
        },
      ],
    };
    expect<unknown>(TaskGrantPreviewSchema.parse(preview)).toEqual(preview);
    const [workflow] = preview.workflows;
    for (const invalid of [
      { ...preview, workflows: [{ ...workflow, blocked_reason: "workflow_slow" }] },
      { ...preview, workflows: [{ ...workflow, effect_manifest_digest: "abc" }] },
      { ...preview, grantable: "no" },
      { ...preview, fingerprint: "abc" },
    ])
      expect(accepts(TaskGrantPreviewSchema, invalid)).toBe(false);
  });

  test("the run marker is exactly the six session fields", () => {
    expect<unknown>(TaskRunMarkerSchema.parse(marker)).toEqual(marker);
    expect(Object.keys(TaskRunMarkerSchema.shape).sort()).toEqual([
      "connector_ids",
      "environment",
      "task_id",
      "task_run_id",
      "web_search",
      "workflow_ids",
    ]);
    for (const invalid of [
      { ...marker, environment: "staging" },
      { ...marker, workflow_ids: ["x"] },
      { ...marker, connector_ids: null },
      { ...marker, web_search: "yes" },
      { ...marker, task_run_id: undefined },
      { ...marker, grant_id: ID },
    ])
      expect(accepts(TaskRunMarkerSchema, invalid)).toBe(false);
  });
});
