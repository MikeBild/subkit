import { describe, expect, test } from "bun:test";
import { TASK_RUN_FAILURE_CODES } from "./failure-codes.ts";
import type { TaskPlaybookFacts } from "./plan-instance.ts";
import {
  decideTaskRunResume,
  decideTaskRunState,
  normalizeFailureCode,
  TASK_NO_PROGRESS_LIMIT,
  TASK_SLEEP_REASONS,
  TASK_TURN_FAILURES_BEFORE_THE_MODEL,
  TASK_TURN_STOPPED,
  type TaskRunDecision,
  type TaskRunObservation,
  type TaskRunProgress,
  taskRunIsOpen,
  taskRunLimitReached,
} from "./run-state.ts";

const NOW = new Date("2026-11-19T08:00:00.000Z");
const TURN = "00000000-0000-4000-8000-0000000000b1";
const PERSON = "00000000-0000-4000-8000-0000000000c1";
const at = (offset: number) => new Date(NOW.getTime() + offset);

function playbook(overrides: Partial<TaskPlaybookFacts> = {}): TaskPlaybookFacts {
  return {
    status: "in_progress",
    revision: 3,
    intact: true,
    result_confirmed: false,
    awaiting_result_confirmation: false,
    ...overrides,
  };
}

function observation(overrides: Partial<TaskRunObservation> = {}): TaskRunObservation {
  return {
    conversation_status: "active",
    pending_elicitation: null,
    playbook: playbook(),
    requested_check_at: null,
    turn_id: TURN,
    turn_seq: null,
    turn_driver: "task",
    turn_failure: null,
    turn_interrupted: false,
    human_input_since_last_turn: false,
    result_confirmed_by: null,
    result_rejected: false,
    ...overrides,
  };
}

function run(overrides: Partial<TaskRunProgress> = {}): TaskRunProgress {
  return {
    turns_used: 4,
    no_progress_count: 0,
    last_playbook_revision: 2,
    last_seen_turn_seq: 3,
    rejected_playbook_revision: null,
    deadline_at: at(60_000),
    ...overrides,
  };
}

const LIMITS = { max_turns: 20 };

function decide(
  o: Partial<TaskRunObservation> = {},
  r: Partial<TaskRunProgress> = {},
  limits = LIMITS,
): TaskRunDecision {
  return decideTaskRunState(observation(o), run(r), limits, NOW);
}

function outcome(decision: TaskRunDecision) {
  const { state, waiting_reason, next_check_at, sleep_reason, enqueue, failure_code } = decision;
  return { state, waiting_reason, next_check_at, sleep_reason, enqueue, failure_code };
}

const settled = (state: TaskRunDecision["state"], extra: Partial<TaskRunDecision> = {}) => ({
  state,
  waiting_reason: null,
  next_check_at: null,
  sleep_reason: null,
  enqueue: false,
  failure_code: null,
  ...extra,
});

const failure = (code: string, retry_at: Date | null = null) => ({ code, retry_at });
const noisy: Partial<TaskRunObservation> = {
  pending_elicitation: "question",
  requested_check_at: at(5000),
  turn_failure: failure("llm_quota_exhausted", at(9000)),
  turn_interrupted: true,
};
const stuck: Partial<TaskRunProgress> = {
  no_progress_count: 5,
  turns_used: 99,
  deadline_at: at(-1),
};
const confirmed = playbook({ status: "completed", result_confirmed: true });

describe("decideTaskRunState", () => {
  test("continues and asks for the next turn when nothing stops it", () => {
    expect(decide()).toEqual({
      state: "running",
      waiting_reason: null,
      next_check_at: null,
      sleep_reason: null,
      enqueue: true,
      failure_code: null,
      turns_used: 5,
      no_progress_count: 0,
      last_playbook_revision: 3,
      last_seen_turn_seq: 3,
      turn_seen: true,
    });
  });

  test("a turn counts once: a newer position is remembered, an older or equal one is old news", () => {
    expect(decide({ turn_seq: 4 })).toMatchObject({
      turns_used: 5,
      last_seen_turn_seq: 4,
      turn_seen: true,
    });
    expect(decide({ turn_id: null, turn_seq: 9 })).toMatchObject({
      turns_used: 4,
      last_seen_turn_seq: 3,
      turn_seen: false,
    });
    for (const turn_seq of [3, 2]) {
      const stale = decide(
        {
          turn_seq,
          playbook: playbook({ revision: 2 }),
          turn_failure: { code: "llm_provider_unavailable", retry_at: null },
          turn_interrupted: true,
        },
        { no_progress_count: 1 },
      );
      expect(stale).toMatchObject({
        state: "running",
        failure_code: null,
        turns_used: 4,
        no_progress_count: 1,
        last_seen_turn_seq: 3,
        turn_seen: false,
      });
    }
    expect(
      outcome(decide({ turn_seq: 3, turn_failure: { code: "x", retry_at: at(5_000) } })),
    ).toEqual(settled("running", { enqueue: true }));
    expect(outcome(decide({ turn_seq: 3, turn_interrupted: true }))).toEqual(
      settled("running", { enqueue: true }),
    );
    expect(decide({ turn_seq: 4, turn_interrupted: true }).failure_code).toBe("turn_interrupted");
  });

  test("a rejected result is worked on again and is not offered again until the plan changed", () => {
    for (const facts of [
      playbook({ status: "prepared" }),
      playbook({ awaiting_result_confirmation: true }),
    ]) {
      expect(outcome(decide({ playbook: facts }))).toEqual(settled("result_ready"));
      expect(outcome(decide({ playbook: facts, result_rejected: true }))).toEqual(
        settled("running", { enqueue: true }),
      );
      expect(outcome(decide({ playbook: facts }, { rejected_playbook_revision: 3 }))).toEqual(
        settled("running", { enqueue: true }),
      );
      expect(outcome(decide({ playbook: facts }, { rejected_playbook_revision: 2 }))).toEqual(
        settled("result_ready"),
      );
      expect(
        outcome(
          decide(
            { playbook: facts, pending_elicitation: "question" },
            { rejected_playbook_revision: 3 },
          ),
        ),
      ).toEqual(settled("waiting", { waiting_reason: "question" }));
    }
    expect(decide({ result_rejected: true }).state).toBe("running");
    expect(decide({ playbook: null }, { rejected_playbook_revision: 2 }).failure_code).toBe(
      "playbook_tampered",
    );
  });

  test("a turn refused before the model was called does not use up a turn", () => {
    expect(TASK_TURN_FAILURES_BEFORE_THE_MODEL).toEqual([
      "llm_quota_exhausted",
      "ai_access_missing",
    ]);
    for (const code of TASK_TURN_FAILURES_BEFORE_THE_MODEL)
      expect(decide({ turn_failure: failure(code) })).toMatchObject({
        state: "waiting",
        turns_used: 4,
        turn_seen: true,
      });
    expect(decide({ turn_failure: failure("llm_provider_limited", at(5_000)) }).turns_used).toBe(5);
    expect(decide({ turn_seq: 3, turn_failure: failure("llm_quota_exhausted") }).turns_used).toBe(
      4,
    );
  });

  test("a turn somebody stopped waits for the person instead of failing the run", () => {
    expect(outcome(decide({ turn_failure: failure(TASK_TURN_STOPPED) }))).toEqual(
      settled("waiting", { waiting_reason: "turn_stopped" }),
    );
    expect(TASK_TURN_STOPPED).toBe("turn_stopped");
    expect(outcome(decide({ turn_failure: failure("turn_cancelled") }))).toEqual(
      settled("failed", { failure_code: "turn_failed" }),
    );
  });

  test("an expired question keeps the run waiting under its own reason", () => {
    expect(outcome(decide({ pending_elicitation: "question_expired" }))).toEqual(
      settled("waiting", { waiting_reason: "question_expired" }),
    );
  });

  test("a closed or deleted conversation fails the run before anything else", () => {
    for (const conversation_status of ["abandoned", "missing"] as const)
      expect(
        outcome(decide({ ...noisy, conversation_status, playbook: confirmed }, stuck)),
      ).toEqual(settled("failed", { failure_code: "conversation_closed" }));
    for (const conversation_status of ["awaiting_input", "committed"] as const)
      expect(decide({ conversation_status }).state).toBe("running");
  });

  const tampered: Array<[string, TaskPlaybookFacts | null]> = [
    ["no readable playbook", null],
    ["plan no longer intact", playbook({ intact: false })],
    [
      "rewritten plan that claims completion",
      playbook({ intact: false, status: "completed", result_confirmed: true }),
    ],
    [
      "rewritten plan that claims a result",
      playbook({ intact: false, awaiting_result_confirmation: true }),
    ],
    ["rewritten plan that is prepared", playbook({ intact: false, status: "prepared" })],
    [
      "completed without the confirmation",
      playbook({ status: "completed", result_confirmed: false }),
    ],
  ];
  for (const [label, facts] of tampered)
    test(`a playbook the model reshaped fails the run: ${label}`, () => {
      expect(outcome(decide({ ...noisy, playbook: facts }, stuck))).toEqual(
        settled("failed", { failure_code: "playbook_tampered" }),
      );
    });

  test("an intact, completed playbook confirmed by a person completes the run", () => {
    expect(
      outcome(decide({ ...noisy, playbook: confirmed, result_confirmed_by: PERSON }, stuck)),
    ).toEqual(settled("completed"));
  });

  test("without a known person a confirmed result stays ready instead of completing", () => {
    expect(outcome(decide({ ...noisy, playbook: confirmed }, stuck))).toEqual(
      settled("result_ready"),
    );
  });

  test("a confirmed step alone does not complete the run", () => {
    expect(decide({ playbook: playbook({ result_confirmed: true }) }).state).toBe("running");
  });

  test("a cancelled playbook fails the run", () => {
    expect(
      outcome(decide({ ...noisy, playbook: playbook({ status: "cancelled" }) }, stuck)),
    ).toEqual(settled("failed", { failure_code: "playbook_cancelled" }));
  });

  test("a prepared playbook or an open final confirmation means the result is ready", () => {
    expect(
      outcome(decide({ ...noisy, playbook: playbook({ status: "prepared" }) }, stuck)),
    ).toEqual(settled("result_ready"));
    expect(
      outcome(
        decide({ ...noisy, playbook: playbook({ awaiting_result_confirmation: true }) }, stuck),
      ),
    ).toEqual(settled("result_ready"));
  });

  test("a pending question or approval waits for the person", () => {
    for (const kind of ["question", "approval"] as const)
      expect(outcome(decide({ ...noisy, pending_elicitation: kind }, stuck))).toEqual(
        settled("waiting", { waiting_reason: kind }),
      );
  });

  test("an exhausted budget and missing AI access wait", () => {
    const rest = { turn_interrupted: true, requested_check_at: at(1) };
    expect(
      outcome(decide({ ...rest, turn_failure: failure("llm_quota_exhausted", at(9000)) }, stuck)),
    ).toEqual(settled("waiting", { waiting_reason: "budget" }));
    expect(
      outcome(decide({ ...rest, turn_failure: failure("ai_access_missing", at(9000)) }, stuck)),
    ).toEqual(settled("waiting", { waiting_reason: "ai_access" }));
  });

  test("any other failure without a retry time fails the run with a normalized code", () => {
    expect(
      outcome(
        decide(
          {
            turn_failure: failure("Provider Error!"),
            requested_check_at: at(1),
            turn_interrupted: true,
          },
          stuck,
        ),
      ),
    ).toEqual(settled("failed", { failure_code: "turn_failed" }));
  });

  test("an interrupted turn fails the run", () => {
    expect(outcome(decide({ turn_interrupted: true, requested_check_at: at(1) }, stuck))).toEqual(
      settled("failed", { failure_code: "turn_interrupted" }),
    );
  });

  test("the turn limit and the deadline stop a run that would otherwise sleep", () => {
    const sleepy = {
      turn_failure: failure("rate_limited", at(9000)),
      requested_check_at: at(5000),
    };
    const waiting = settled("waiting", { waiting_reason: "no_progress" });
    expect(outcome(decide(sleepy, { turns_used: 19 }))).toEqual(waiting);
    expect(outcome(decide(sleepy, { turns_used: 25 }))).toEqual(waiting);
    expect(outcome(decide(sleepy, { deadline_at: NOW }))).toEqual(waiting);
    expect(outcome(decide(sleepy, { deadline_at: at(-1) }))).toEqual(waiting);
    expect(decide(sleepy, { turns_used: 18 }).state).toBe("sleeping");
    expect(decide(sleepy, { deadline_at: at(1) }).state).toBe("sleeping");
    expect(outcome(decide({}, { turns_used: 0 }, { max_turns: 1 }))).toEqual(waiting);
  });

  test("provider throttling sleeps until the retry time, never past the deadline", () => {
    expect(
      outcome(
        decide(
          { turn_failure: failure("rate_limited", at(9000)), requested_check_at: at(5000) },
          { no_progress_count: 5 },
        ),
      ),
    ).toEqual(settled("sleeping", { next_check_at: at(9000), sleep_reason: "provider_throttled" }));
    expect(decide({ turn_failure: failure("rate_limited", at(-9000)) }).next_check_at).toEqual(NOW);
    expect(decide({ turn_failure: failure("rate_limited", NOW) }).next_check_at).toEqual(NOW);
    expect(decide({ turn_failure: failure("rate_limited", at(90_000)) }).next_check_at).toEqual(
      at(60_000),
    );
    expect(decide({ turn_failure: failure("rate_limited", at(60_000)) }).next_check_at).toEqual(
      at(60_000),
    );
  });

  test("a requested check time sleeps until then, beats the no-progress rule and respects the deadline", () => {
    expect(outcome(decide({ requested_check_at: at(5000) }, { no_progress_count: 5 }))).toEqual(
      settled("sleeping", { next_check_at: at(5000), sleep_reason: "check_requested" }),
    );
    expect(decide({ requested_check_at: at(90_000) }).next_check_at).toEqual(at(60_000));
  });

  test("a check time at or before now counts as no request", () => {
    expect(decide({ requested_check_at: NOW }).state).toBe("running");
    expect(decide({ requested_check_at: at(-5000) }).state).toBe("running");
    expect(
      decide(
        { requested_check_at: at(-5000), playbook: playbook({ revision: 2 }) },
        { no_progress_count: 5 },
      ).state,
    ).toBe("waiting");
    expect(decide({ requested_check_at: at(1) }).state).toBe("sleeping");
  });

  test("two turns in a row without a playbook change wait for the person", () => {
    const same = { playbook: playbook({ revision: 2 }) };
    expect(TASK_NO_PROGRESS_LIMIT).toBe(2);
    expect(decide(same, { no_progress_count: 0 })).toMatchObject({
      state: "running",
      no_progress_count: 1,
    });
    expect(decide(same, { no_progress_count: 1 })).toMatchObject({
      state: "waiting",
      waiting_reason: "no_progress",
      no_progress_count: 2,
      enqueue: false,
    });
    expect(decide(same, { no_progress_count: 7 })).toMatchObject({
      state: "waiting",
      no_progress_count: 8,
    });
  });

  test("a playbook change or a fresh answer resets the stall counter", () => {
    expect(decide({}, { no_progress_count: 1 })).toMatchObject({
      state: "running",
      no_progress_count: 0,
      last_playbook_revision: 3,
    });
    expect(
      decide(
        { playbook: playbook({ revision: 2 }), human_input_since_last_turn: true },
        { no_progress_count: 1 },
      ),
    ).toMatchObject({ state: "running", no_progress_count: 0 });
  });

  test("an observation without a turn counts nothing", () => {
    const same = { playbook: playbook({ revision: 2 }), turn_id: null };
    expect(decide(same, { no_progress_count: 1 })).toMatchObject({
      state: "running",
      turns_used: 4,
      no_progress_count: 1,
    });
    expect(decide({ turn_id: null }, { no_progress_count: 1 })).toMatchObject({
      turns_used: 4,
      no_progress_count: 0,
    });
    expect(decide({ turn_id: null }, { turns_used: 19 }).state).toBe("running");
  });

  test("a turn a person drives does not use up the turn limit but still shows a stall", () => {
    const person = { turn_driver: "person" as const, playbook: playbook({ revision: 2 }) };
    expect(decide(person, { turns_used: 19 })).toMatchObject({
      state: "running",
      turns_used: 19,
      no_progress_count: 1,
    });
    expect(decide({ turn_driver: "person" }, { turns_used: 19 }).turns_used).toBe(19);
    expect(decide({}, { turns_used: 0 }).turns_used).toBe(1);
    expect(decide({ playbook: confirmed }, { turns_used: 7 }).turns_used).toBe(8);
    expect(decide({ turn_failure: failure("Turn_Interrupted ") }).failure_code).toBe(
      "turn_interrupted",
    );
  });

  test("the answering person and a rejection do not change the decision itself", () => {
    expect(decide({ result_confirmed_by: PERSON, result_rejected: true })).toEqual(decide());
  });
});

describe("normalizeFailureCode", () => {
  test("keeps every code of the closed list", () => {
    for (const code of TASK_RUN_FAILURE_CODES) expect(normalizeFailureCode(code)).toBe(code);
    expect(TASK_RUN_FAILURE_CODES).toEqual([
      "turn_failed",
      "turn_interrupted",
      "start_failed",
      "playbook_tampered",
      "playbook_cancelled",
      "conversation_closed",
      "task_changed",
      "task_archived",
      "owner_unavailable",
      "budget_exhausted",
      "deadline_exceeded",
    ]);
  });

  test("accepts another spelling of a known code", () => {
    expect(normalizeFailureCode("  Deadline_Exceeded ")).toBe("deadline_exceeded");
    expect(normalizeFailureCode("BUDGET_EXHAUSTED")).toBe("budget_exhausted");
  });

  const unknown = ["provider_error", "rate_limited", "", "???", "turn_failed_", "x".repeat(250)];
  for (const code of unknown)
    test(`${JSON.stringify(code.slice(0, 20))} becomes turn_failed`, () => {
      expect(normalizeFailureCode(code)).toBe("turn_failed");
    });
});

describe("decideTaskRunResume and taskRunLimitReached", () => {
  const state = (value: "waiting" | "sleeping", overrides: Partial<TaskRunProgress> = {}) => ({
    ...run({ no_progress_count: 2, ...overrides }),
    state: value,
  });

  test("resuming from waiting resets the stall counter, from sleeping it does not", () => {
    expect(decideTaskRunResume(state("waiting"), LIMITS, NOW)).toEqual({
      resume: true,
      no_progress_count: 0,
    });
    expect(decideTaskRunResume(state("sleeping"), LIMITS, NOW)).toEqual({
      resume: true,
      no_progress_count: 2,
    });
  });

  test("a run out of turns or past its deadline does not resume", () => {
    const refused = { resume: false, waiting_reason: "no_progress" } as const;
    expect(decideTaskRunResume(state("waiting", { turns_used: 20 }), LIMITS, NOW)).toEqual(refused);
    expect(decideTaskRunResume(state("sleeping", { turns_used: 21 }), LIMITS, NOW)).toEqual(
      refused,
    );
    expect(decideTaskRunResume(state("sleeping", { deadline_at: NOW }), LIMITS, NOW)).toEqual(
      refused,
    );
    expect(decideTaskRunResume(state("waiting", { deadline_at: at(-1) }), LIMITS, NOW)).toEqual(
      refused,
    );
    expect(
      decideTaskRunResume(state("waiting", { turns_used: 19, deadline_at: at(1) }), LIMITS, NOW)
        .resume,
    ).toBe(true);
  });

  test("the limit is reached at the last turn or at the deadline", () => {
    expect(taskRunLimitReached({ turns_used: 19, deadline_at: at(1) }, LIMITS, NOW)).toBe(false);
    expect(taskRunLimitReached({ turns_used: 20, deadline_at: at(1) }, LIMITS, NOW)).toBe(true);
    expect(taskRunLimitReached({ turns_used: 0, deadline_at: NOW }, LIMITS, NOW)).toBe(true);
  });
});

describe("taskRunIsOpen", () => {
  test("running, waiting and sleeping block the next start", () => {
    const open = ["running", "waiting", "sleeping"] as const;
    const closed = ["result_ready", "completed", "aborted", "failed"] as const;
    for (const state of open) expect(taskRunIsOpen(state)).toBe(true);
    for (const state of closed) expect(taskRunIsOpen(state)).toBe(false);
    expect(TASK_SLEEP_REASONS).toEqual(["paused", "check_requested", "provider_throttled"]);
  });
});
