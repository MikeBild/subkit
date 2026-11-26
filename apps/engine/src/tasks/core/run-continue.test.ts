import { describe, expect, test } from "bun:test";
import { PlaybookPlanSchema } from "../../conversations/public/authoring.ts";
import { carriedTaskPlan } from "./plan-instance.ts";
import {
  decideTaskRunContinuation,
  taskRunReattachment,
  taskRunStillHeldBy,
} from "./run-continue.ts";

const OWNER = "7a0c2c2e-0000-4000-8000-000000000001";
const OTHER = "7a0c2c2e-0000-4000-8000-000000000002";
const OLD_CONVERSATION = "7a0c2c2e-0000-4000-8000-0000000000c1";
const NEW_CONVERSATION = "7a0c2c2e-0000-4000-8000-0000000000c2";

const held = {
  state: "waiting" as const,
  waiting_reason: "conversation_abandoned" as const,
  conversation_id: OLD_CONVERSATION,
};

function decide(overrides: Partial<Parameters<typeof decideTaskRunContinuation>[0]> = {}) {
  return decideTaskRunContinuation({
    run: held,
    owner_id: OWNER,
    person_id: OWNER,
    task_paused: false,
    ...overrides,
  });
}

describe("continuing a run in a new conversation", () => {
  test("the owner continues a run held by its abandoned conversation", () => {
    expect(decide()).toEqual({ ok: true });
  });

  test("anyone else is refused, even when the run is held", () => {
    expect(decide({ person_id: OTHER })).toEqual({ ok: false, reason: "not_owner" });
  });

  test("only a run held by its abandoned conversation can move", () => {
    for (const run of [
      { ...held, waiting_reason: "turn_stopped" as const },
      { ...held, waiting_reason: "question" as const },
      { state: "running" as const, waiting_reason: null, conversation_id: OLD_CONVERSATION },
      { state: "aborted" as const, waiting_reason: null, conversation_id: OLD_CONVERSATION },
      { ...held, conversation_id: null },
    ])
      expect(decide({ run })).toEqual({ ok: false, reason: "not_held" });
  });

  test("a paused task keeps its run until the owner resumes the task", () => {
    expect(decide({ task_paused: true })).toEqual({ ok: false, reason: "paused" });
  });

  test("the run is still held only by the conversation it was checked with", () => {
    expect(taskRunStillHeldBy(held, OLD_CONVERSATION)).toBe(true);
    expect(
      taskRunStillHeldBy({ ...held, conversation_id: NEW_CONVERSATION }, OLD_CONVERSATION),
    ).toBe(false);
    expect(
      taskRunStillHeldBy(
        { state: "running", waiting_reason: null, conversation_id: OLD_CONVERSATION },
        OLD_CONVERSATION,
      ),
    ).toBe(false);
  });

  test("re-attaching runs again and restarts the per-conversation counters", () => {
    expect(
      taskRunReattachment({
        conversation_id: NEW_CONVERSATION,
        playbook_revision: 1,
        no_progress_count: 0,
      }),
    ).toEqual({
      conversation_id: NEW_CONVERSATION,
      state: "running",
      waiting_reason: null,
      next_check_at: null,
      sleep_reason: null,
      no_progress_count: 0,
      last_seen_turn_id: null,
      last_seen_turn_seq: 0,
      last_playbook_revision: 1,
      rejected_playbook_revision: null,
      turn_job_failures: 0,
    });
  });

  test("the carried plan keeps progress and results but drops references to the old conversation", () => {
    const plan = PlaybookPlanSchema.parse({
      title: "Weekly report",
      goal: "Send the weekly report",
      steps: [
        {
          id: "collect",
          label: "Collect numbers",
          criterion: {
            kind: "assessment",
            description: "The numbers of the week are collected",
            result: "Numbers collected from the shop export",
          },
          depends_on: [],
          evidence_ids: ["7a0c2c2e-0000-4000-8000-0000000000e1"],
          note: "Numbers from the shop",
          progress: "in_progress",
          next_action: null,
        },
        {
          id: "ask",
          label: "Ask for the recipient",
          criterion: { kind: "assessment", description: "The recipient is known", result: null },
          depends_on: ["collect"],
          evidence_ids: [],
          note: null,
          progress: "open",
          next_action: {
            label: "Who receives the report?",
            owner: "person",
            elicitation_id: "7a0c2c2e-0000-4000-8000-0000000000a1",
          },
        },
      ],
      cancelled: false,
      completion_step_id: null,
    });

    const carried = carriedTaskPlan(plan);

    expect(carried.steps.map((step) => step.evidence_ids)).toEqual([[], []]);
    expect(carried.steps[1]?.next_action).toMatchObject({
      label: "Who receives the report?",
      elicitation_id: null,
    });
    expect(carried.steps[0]).toMatchObject({
      note: "Numbers from the shop",
      progress: "in_progress",
      criterion: { kind: "assessment", result: "Numbers collected from the shop export" },
    });
    expect(plan.steps[0]?.evidence_ids).toHaveLength(1);
  });
});
