import { describe, expect, test } from "bun:test";
import { EVENT_CLASS_ACTIONS } from "../api/stats/event-classes.ts";
import {
  TASK_ADMISSION_REASONS,
  TASK_ENVIRONMENTS,
  TASK_PAUSED_REASONS,
  TASK_RUN_STATES,
  TASK_RUN_TRIGGERS,
  TASK_RUN_WAITING_REASONS,
} from "../tasks/types.ts";
import { projectAuditEntry, TASK_DETAIL_VOCABULARY } from "./projection.ts";
import { AuditAction, type AuditEntry } from "./types.ts";

const TASK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GRANT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VALID_FROM = "2026-11-19T08:00:00.000Z";
const VALID_UNTIL = "2026-12-19T08:00:00.000Z";

const PRIVATE = {
  goal: "private-goal-canary",
  done_when: "private-done-canary",
  plan: { steps: [{ title: "private-plan-canary" }] },
  answer: "private-answer-canary",
  question: "private-question-canary",
  sleep_reason: "private sleep reason canary, written by the model",
  owner_email: "private-owner-canary@example.test",
  workflow_names: ["private-workflow-name-canary"],
};
const CANARIES = [
  "private-goal-canary",
  "private-done-canary",
  "private-plan-canary",
  "private-answer-canary",
  "private-question-canary",
  "private sleep reason canary",
  "private-owner-canary",
  "private-workflow-name-canary",
];

function entry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    ts: new Date("2026-11-19T10:15:30.000Z"),
    tenant_id: "22222222-2222-4222-8222-222222222222",
    actor_type: "system",
    actor_id: null,
    action: AuditAction.TASK_CREATED,
    resource_type: "task",
    resource_id: TASK,
    result: "success",
    trace_id: "trace",
    ip: null,
    user_agent: null,
    before: null,
    after: null,
    reason: null,
    metadata: {},
    ...overrides,
  };
}

interface ActionCase {
  action: AuditEntry["action"];
  resource_type: "task" | "task_run" | "task_grant";
  safe: Record<string, string | number | boolean | null>;
  arrays?: Record<string, string[]>;
}

const FINGERPRINT = "f".repeat(64);
const IDS = [TASK, RUN, GRANT];

const CASES: ActionCase[] = [
  {
    action: AuditAction.TASK_CREATED,
    resource_type: "task",
    safe: { revision: 1, environment: "prod", owner_id: OWNER, schedule_kind: "cron" },
  },
  {
    action: AuditAction.TASK_UPDATED,
    resource_type: "task",
    safe: {
      revision: 4,
      previous_revision: 3,
      environment: "prod",
      schedule_kind: "once",
      grant_invalidated: true,
    },
  },
  { action: AuditAction.TASK_DELETED, resource_type: "task", safe: { revision: 4 } },
  {
    action: AuditAction.TASK_PAUSED,
    resource_type: "task",
    safe: { paused_reason: "owner_unavailable" },
  },
  {
    action: AuditAction.TASK_RESUMED,
    resource_type: "task",
    safe: { previous_paused_reason: "admin" },
  },
  {
    action: AuditAction.TASK_AUTHORITY_GRANTED,
    resource_type: "task_grant",
    safe: {
      task_grant_id: GRANT,
      execution_environment: "prod",
      fingerprint: FINGERPRINT,
      valid_from: VALID_FROM,
      valid_until: VALID_UNTIL,
      max_runs: 30,
      open_ended: false,
    },
    arrays: {
      workflow_authority_ids: IDS,
      covered_workflow_ids: [TASK],
      superseded_grant_ids: [],
    },
  },
  {
    action: AuditAction.TASK_AUTHORITY_REVOKED,
    resource_type: "task_grant",
    safe: {
      task_grant_id: GRANT,
      execution_environment: "prod",
      fingerprint: FINGERPRINT,
      valid_from: VALID_FROM,
      valid_until: null,
      max_runs: null,
      open_ended: true,
      reason_code: "task_changed",
      reserved_runs: 2,
    },
    arrays: {
      revoked_workflow_authority_ids: IDS,
      retained_successor_authority_ids: [RUN],
      transferred_workflow_authority_ids: [],
    },
  },
  {
    action: AuditAction.TASK_ADMISSION_CHANGED,
    resource_type: "task",
    safe: { state: "held", reason_code: "grant_expired", trigger: "cron" },
  },
  {
    action: AuditAction.TASK_SCHEDULE_CLAIMED,
    resource_type: "task",
    safe: { trigger: "cron", scheduled_for: VALID_FROM, task_grant_id: GRANT },
  },
  {
    action: AuditAction.TASK_RUN_STARTED,
    resource_type: "task_run",
    safe: {
      trigger: "manual",
      task_revision: 4,
      task_grant_id: null,
      environment: "dev",
      deadline_at: VALID_UNTIL,
    },
  },
  {
    action: AuditAction.TASK_RUN_WAITING,
    resource_type: "task_run",
    safe: { state: "waiting", waiting_reason: "question", turns_used: 3 },
  },
  {
    action: AuditAction.TASK_RUN_RESUMED,
    resource_type: "task_run",
    safe: { previous_state: "sleeping", resume_reason: "check_due", turns_used: 3 },
  },
  { action: AuditAction.TASK_RUN_RESULT_READY, resource_type: "task_run", safe: { turns_used: 5 } },
  {
    action: AuditAction.TASK_RUN_COMPLETED,
    resource_type: "task_run",
    safe: { previous_state: "result_ready", turns_used: 5, duration_ms: 91_000 },
  },
  {
    action: AuditAction.TASK_RUN_FAILED,
    resource_type: "task_run",
    safe: {
      previous_state: "running",
      failure_code: "turn_limit_reached",
      turns_used: 2,
      duration_ms: 4_000,
    },
  },
  {
    action: AuditAction.TASK_RUN_ABORT_REQUESTED,
    resource_type: "task_run",
    safe: { previous_state: "waiting" },
  },
  {
    action: AuditAction.TASK_RUN_ABORTED,
    resource_type: "task_run",
    safe: { previous_state: "waiting", turns_used: 2, duration_ms: 4_000 },
  },
];

function expectedDetails(item: ActionCase): Record<string, unknown> {
  const counts = Object.fromEntries(
    Object.entries(item.arrays ?? {}).map(([name, ids]) => [
      `${name.replace(/_ids$/, "")}_count`,
      ids.length,
    ]),
  );
  return { ...item.safe, ...counts };
}

const RESOURCE_IDS = { task: TASK, task_run: RUN, task_grant: GRANT } as const;

describe("task actions in the audit read projection", () => {
  test("every task and task run action has a case here", () => {
    const declared = Object.values(AuditAction)
      .filter((action) => action.startsWith("task.") || action.startsWith("task_run."))
      .sort();
    expect(CASES.map((item) => item.action).sort()).toEqual(declared);
    expect(declared).toHaveLength(17);
  });

  for (const item of CASES) {
    test(`${item.action} shows its ids, states and validity and drops free text`, () => {
      const projected = projectAuditEntry(
        entry({
          action: item.action,
          resource_type: item.resource_type,
          resource_id: RESOURCE_IDS[item.resource_type],
          before: { name: "Weekly report", ...PRIVATE },
          after: { name: "Weekly report", ...PRIVATE },
          reason: "the owner wrote private-answer-canary here",
          metadata: {
            ...item.safe,
            ...item.arrays,
            ...PRIVATE,
            task_id: TASK,
            task_run_id: RUN,
            unlisted_field: "private-goal-canary",
          },
        }),
      );
      expect(projected.details).toEqual(expectedDetails(item));
      expect(projected.task_id).toBe(TASK);
      expect(projected.task_run_id).toBe(RUN);
      expect(projected.reason).toBeNull();
      expect(projected.reason_redacted).toBe(true);
      expect(projected.before).toBeNull();
      expect(projected.after).toBeNull();
      const wire = JSON.stringify(projected);
      for (const canary of CANARIES) expect(wire).not.toContain(canary);
    });
  }

  for (const item of CASES) {
    test(`${item.action} drops a short phrase under every text key`, () => {
      const textKeys = Object.entries(item.safe)
        .filter(([, value]) => typeof value === "string")
        .map(([key]) => key);
      for (const phrase of ["two words", "grant expired", "prod now", "ok "]) {
        const projected = projectAuditEntry(
          entry({
            action: item.action,
            resource_type: item.resource_type,
            resource_id: RESOURCE_IDS[item.resource_type],
            metadata: {
              ...item.safe,
              ...Object.fromEntries(textKeys.map((key) => [key, phrase])),
            },
          }),
        );
        const details = projected.details as Record<string, unknown>;
        for (const key of textKeys) {
          expect(`${key}=${phrase}: ${String(details[key])}`).toBe(`${key}=${phrase}: undefined`);
        }
      }
    });
  }

  test("the closed sets the projection checks against are the task vocabulary", () => {
    expect(TASK_DETAIL_VOCABULARY.environments).toEqual(TASK_ENVIRONMENTS);
    expect(TASK_DETAIL_VOCABULARY.triggers).toEqual(TASK_RUN_TRIGGERS);
    expect(TASK_DETAIL_VOCABULARY.run_states).toEqual(TASK_RUN_STATES);
    expect(TASK_DETAIL_VOCABULARY.waiting_reasons).toEqual(TASK_RUN_WAITING_REASONS);
    expect(TASK_DETAIL_VOCABULARY.admission_reasons).toEqual(TASK_ADMISSION_REASONS);
    expect(TASK_DETAIL_VOCABULARY.paused_reasons).toEqual(TASK_PAUSED_REASONS);
  });

  test("a value outside its type or closed set is dropped, not coerced", () => {
    const failed = projectAuditEntry(
      entry({
        action: AuditAction.TASK_RUN_FAILED,
        resource_type: "task_run",
        resource_id: RUN,
        metadata: {
          failure_code: "The model said: private-answer-canary, then stopped",
          previous_state: "paused",
          turns_used: Number.NaN,
          duration_ms: 12,
        },
      }),
    );
    expect(failed.details).toEqual({ duration_ms: 12 });
    expect(JSON.stringify(failed)).not.toContain("canary");
    const granted = projectAuditEntry(
      entry({
        action: AuditAction.TASK_AUTHORITY_GRANTED,
        resource_type: "task_grant",
        resource_id: GRANT,
        metadata: {
          task_grant_id: "not-a-uuid",
          grant_id: GRANT,
          execution_environment: "staging",
          environment: "prod",
          fingerprint: "abc",
          valid_from: "tomorrow",
          max_runs: "30",
          open_ended: "yes",
          workflow_authority_count: 9,
          workflow_authority_ids: "private-goal-canary",
          covered_workflow_ids: [TASK, "private-goal-canary"],
        },
      }),
    );
    expect(granted.details).toEqual({ covered_workflow_count: 2 });
    expect(JSON.stringify(granted)).not.toContain("canary");
  });

  test("a failure code is a lower-case code without spaces, up to 200 characters", () => {
    const project = (failure_code: string) =>
      (
        projectAuditEntry(
          entry({
            action: AuditAction.TASK_RUN_FAILED,
            resource_type: "task_run",
            resource_id: RUN,
            metadata: { failure_code },
          }),
        ).details as Record<string, unknown>
      ).failure_code;
    expect(project("llm.provider_error:rate-limit")).toBe("llm.provider_error:rate-limit");
    expect(project("a".repeat(200))).toBe("a".repeat(200));
    expect(project("a".repeat(201))).toBeUndefined();
    expect(project("Turn_Interrupted")).toBeUndefined();
    expect(project("turn interrupted")).toBeUndefined();
    expect(project("")).toBeUndefined();
  });

  test("only the task carries a name, taken from its recorded snapshot", () => {
    const task = projectAuditEntry(
      entry({ action: AuditAction.TASK_DELETED, before: { name: "Weekly report", ...PRIVATE } }),
    );
    expect(task.resource_name).toBe("Weekly report");
    const run = projectAuditEntry(
      entry({
        action: AuditAction.TASK_RUN_STARTED,
        resource_type: "task_run",
        resource_id: RUN,
        after: { name: "private-goal-canary", title: "private-plan-canary" },
      }),
    );
    expect(run.resource_name).toBeNull();
    const grant = projectAuditEntry(
      entry({
        action: AuditAction.TASK_AUTHORITY_GRANTED,
        resource_type: "task_grant",
        resource_id: GRANT,
        after: { name: "private-goal-canary" },
      }),
    );
    expect(grant.resource_name).toBeNull();
  });

  test("a rename and an archive are shown as changes, the goal never is", () => {
    const projected = projectAuditEntry(
      entry({
        action: AuditAction.TASK_UPDATED,
        before: { name: "Weekly report", lifecycle: "active", goal: "private-goal-canary" },
        after: { name: "Monthly report", lifecycle: "archived", goal: "private-done-canary" },
      }),
    );
    expect(projected.changes).toEqual([
      { field: "name", before: "Weekly report", after: "Monthly report" },
      { field: "lifecycle", before: "active", after: "archived" },
    ]);
    expect(JSON.stringify(projected)).not.toContain("canary");
  });

  test("the task and its run are lifted from the resource or from the metadata", () => {
    const own = projectAuditEntry(entry({ action: AuditAction.TASK_PAUSED }));
    expect(own.task_id).toBe(TASK);
    expect(own.task_run_id).toBeNull();
    expect(own.metadata).toEqual({ task_id: TASK });
    const run = projectAuditEntry(
      entry({
        action: AuditAction.TASK_RUN_WAITING,
        resource_type: "task_run",
        resource_id: RUN,
        metadata: { task_id: TASK },
      }),
    );
    expect(run.task_id).toBe(TASK);
    expect(run.task_run_id).toBe(RUN);
    expect(run.metadata).toEqual({ task_id: TASK, task_run_id: RUN });
    const toolCall = projectAuditEntry(
      entry({
        action: AuditAction.EXECUTION_QUEUED,
        resource_type: "execution",
        resource_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        metadata: { task_id: "not-a-uuid", task_run_id: RUN },
      }),
    );
    expect(toolCall.task_id).toBeNull();
    expect(toolCall.task_run_id).toBe(RUN);
  });

  test("admission, waiting and pause reasons are kept, anything else is redacted", () => {
    for (const reason of [
      ...TASK_ADMISSION_REASONS,
      ...TASK_RUN_WAITING_REASONS,
      ...TASK_PAUSED_REASONS,
    ]) {
      const projected = projectAuditEntry(
        entry({ action: AuditAction.TASK_ADMISSION_CHANGED, result: "denied", reason }),
      );
      expect(`${reason}: ${projected.reason}`).toBe(`${reason}: ${reason}`);
      expect(projected.reason_redacted).toBe(false);
    }
    const free = projectAuditEntry(
      entry({ action: AuditAction.TASK_ADMISSION_CHANGED, reason: "grant_expired because of X" }),
    );
    expect(free.reason).toBeNull();
    expect(free.reason_redacted).toBe(true);
  });

  test("the task actions are counted in the schedule and run event classes", () => {
    expect(EVENT_CLASS_ACTIONS.schedule).toEqual(
      expect.arrayContaining([
        AuditAction.TASK_SCHEDULE_CLAIMED,
        AuditAction.TASK_ADMISSION_CHANGED,
      ]),
    );
    const runActions = Object.values(AuditAction).filter((action) =>
      action.startsWith("task_run."),
    );
    expect(EVENT_CLASS_ACTIONS.execution_lifecycle).toEqual(expect.arrayContaining(runActions));
    expect(EVENT_CLASS_ACTIONS.policy).toEqual(
      expect.arrayContaining([
        AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED,
        AuditAction.TOOL_POLICY_CONFIRMATION_SKIPPED,
      ]),
    );
    const classified = Object.values(EVENT_CLASS_ACTIONS).flat();
    expect(new Set(classified).size).toBe(classified.length);
  });
});
