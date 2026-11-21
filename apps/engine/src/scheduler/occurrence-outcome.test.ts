import { describe, expect, test } from "bun:test";
import { occurrenceRunOutcome, occurrenceRunOutcomes } from "./occurrence-outcome.ts";

const states = {
  executions: new Map([
    ["e-ok", "succeeded"],
    ["e-failed", "failed"],
    ["e-timeout", "timed_out"],
    ["e-stopped", "aborted"],
    ["e-queued", "queued"],
  ]),
  task_runs: new Map([
    ["t-failed", "failed"],
    ["t-waiting", "waiting"],
    ["t-ready", "result_ready"],
    ["t-done", "completed"],
  ]),
};

function execution(id: string | null) {
  return { execution_id: id, task_run_id: null };
}

function taskRun(id: string) {
  return { execution_id: null, task_run_id: id };
}

describe("occurrenceRunOutcome", () => {
  test("a run that failed or timed out marks the occurrence failed", () => {
    expect(occurrenceRunOutcome(execution("e-failed"), states)).toBe("failed");
    expect(occurrenceRunOutcome(execution("e-timeout"), states)).toBe("failed");
    expect(occurrenceRunOutcome(taskRun("t-failed"), states)).toBe("failed");
  });

  test("a finished run reads succeeded, a stopped run aborted", () => {
    expect(occurrenceRunOutcome(execution("e-ok"), states)).toBe("succeeded");
    expect(occurrenceRunOutcome(execution("e-stopped"), states)).toBe("aborted");
    expect(occurrenceRunOutcome(taskRun("t-done"), states)).toBe("succeeded");
    expect(occurrenceRunOutcome(taskRun("t-ready"), states)).toBe("succeeded");
  });

  test("a run that has not ended yet reads running", () => {
    expect(occurrenceRunOutcome(execution("e-queued"), states)).toBe("running");
    expect(occurrenceRunOutcome(taskRun("t-waiting"), states)).toBe("running");
  });

  test("no run, or a run that is gone, has no outcome", () => {
    expect(occurrenceRunOutcome(execution(null), states)).toBeNull();
    expect(occurrenceRunOutcome(execution("e-gone"), states)).toBeNull();
  });

  test("outcomes are keyed by occurrence id", () => {
    const map = occurrenceRunOutcomes(
      [
        { id: "o1", ...execution("e-failed") },
        { id: "o2", ...execution(null) },
      ],
      states,
    );
    expect(map.get("o1")).toBe("failed");
    expect(map.get("o2")).toBeNull();
  });
});
