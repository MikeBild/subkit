import { describe, expect, test } from "bun:test";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import {
  decideTaskRunState,
  TASK_CONVERSATION_ABANDONED,
  type TaskRunObservation,
  type TaskRunProgress,
  taskRunHeldForPerson,
} from "./run-state.ts";

const NOW = new Date(FROZEN_NOW);

function observation(overrides: Partial<TaskRunObservation> = {}): TaskRunObservation {
  return {
    conversation_status: "abandoned",
    pending_elicitation: null,
    playbook: {
      status: "in_progress",
      revision: 3,
      intact: true,
      result_confirmed: false,
      awaiting_result_confirmation: false,
      progress_marks: [],
    },
    requested_check_at: null,
    turn_id: null,
    turn_seq: null,
    turn_driver: "task",
    turn_failure: { code: TASK_CONVERSATION_ABANDONED, retry_at: null },
    turn_interrupted: false,
    human_input_since_last_turn: false,
    progress_marks: [],
    result_confirmed_by: null,
    result_rejected: false,
    ...overrides,
  };
}

const RUN: TaskRunProgress = {
  turns_used: 4,
  no_progress_count: 0,
  last_playbook_revision: 2,
  progress_marks: [],
  last_seen_turn_seq: 3,
  rejected_playbook_revision: null,
  deadline_at: new Date(NOW.getTime() + 60_000),
};

const decide = (o: Partial<TaskRunObservation> = {}) =>
  decideTaskRunState(observation(o), RUN, { max_turns: 20 }, NOW);

describe("a question refused on an abandoned conversation", () => {
  test("holds the run for the person instead of failing it", () => {
    expect(decide()).toMatchObject({
      state: "waiting",
      waiting_reason: "conversation_abandoned",
      failure_code: null,
      enqueue: false,
    });
  });

  test("an abandoned conversation without a refused question still fails the run", () => {
    expect(decide({ turn_failure: null })).toMatchObject({
      state: "failed",
      failure_code: "conversation_closed",
    });
    expect(decide({ conversation_status: "missing" })).toMatchObject({
      state: "failed",
      failure_code: "conversation_closed",
    });
  });

  test("only a run held for its abandoned conversation ignores later observations", () => {
    expect(
      taskRunHeldForPerson({ state: "waiting", waiting_reason: "conversation_abandoned" }),
    ).toBe(true);
    expect(taskRunHeldForPerson({ state: "waiting", waiting_reason: "turn_stopped" })).toBe(false);
    expect(taskRunHeldForPerson({ state: "running", waiting_reason: null })).toBe(false);
  });
});
