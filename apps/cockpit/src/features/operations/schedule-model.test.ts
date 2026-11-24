import { describe, expect, test } from "bun:test";
import { occurrenceLabel, occurrenceTone, sortOccurrences, toOccurrence } from "./schedule-model";

const base = {
  id: "o1",
  workflow_id: "wf",
  task_id: null,
  due_at: "2026-11-20T07:00:00.000Z",
  started_at: null,
  reason_code: null,
  skipped_count: 0,
  execution_id: null,
};

describe("schedule occurrences in the click-dummy's shape", () => {
  test("engine states map onto ran, late, skipped and held", () => {
    expect(toOccurrence({ ...base, state: "ran" }).state).toBe("ran");
    expect(toOccurrence({ ...base, state: "ran_late" }).state).toBe("late");
    expect(toOccurrence({ ...base, state: "skipped" }).state).toBe("skipped");
    expect(toOccurrence({ ...base, state: "held" }).state).toBe("held");
  });

  test("a late run counts the times it stood in for, a single skip counts nothing extra", () => {
    expect(toOccurrence({ ...base, state: "ran_late", skipped_count: 2 }).covers).toBe(3);
    expect(
      toOccurrence({ ...base, state: "ran_late", reason_code: "merged_missed", skipped_count: 1 })
        .covers,
    ).toBe(2);
    expect(
      toOccurrence({ ...base, state: "ran_late", reason_code: "late_start", skipped_count: 0 })
        .covers,
    ).toBe(0);
    expect(toOccurrence({ ...base, state: "skipped", skipped_count: 1 }).covers).toBe(0);
    expect(toOccurrence({ ...base, state: "held", skipped_count: 3 }).covers).toBe(3);
    expect(toOccurrence({ ...base, state: "ran", skipped_count: 4 }).covers).toBe(0);
  });

  test("keeps the run, the reason code and the subject", () => {
    const o = toOccurrence({
      ...base,
      workflow_id: null,
      task_id: "task",
      state: "held",
      reason_code: "grant_required",
      execution_id: "run",
    });
    expect(o).toMatchObject({ ref: "task", reasonCode: "grant_required", runId: "run" });
  });

  test("newest first", () => {
    const a = toOccurrence({ ...base, id: "a", state: "ran", due_at: "2026-11-19T07:00:00Z" });
    const b = toOccurrence({ ...base, id: "b", state: "ran", due_at: "2026-11-20T07:00:00Z" });
    expect(sortOccurrences([a, b]).map((o) => o.id)).toEqual(["b", "a"]);
  });
});

describe("the run an occurrence started", () => {
  test("a failed run turns a ran row into a danger row that links to the run", () => {
    const failed = toOccurrence({
      ...base,
      state: "ran",
      execution_id: "ex1",
      run_outcome: "failed",
    });
    expect(failed).toMatchObject({ outcome: "failed", runId: "ex1" });
    expect(occurrenceTone(failed)).toBe("danger");
    expect(occurrenceLabel(failed)).toBe("failed");
  });

  test("a task run links by its own id, a missing outcome keeps the timing state", () => {
    const task = toOccurrence({ ...base, state: "ran_late", task_run_id: "tr1" });
    expect(task).toMatchObject({ runId: "tr1", outcome: null });
    expect(occurrenceTone(task)).toBe("warning");
    expect(occurrenceLabel(task)).toBe("late");
  });

  test("running and aborted runs say so, skipped and held rows never carry an outcome label", () => {
    expect(occurrenceLabel({ state: "ran", outcome: "running" })).toBe("running");
    expect(occurrenceTone({ state: "ran", outcome: "running" })).toBe("info");
    expect(occurrenceLabel({ state: "late", outcome: "aborted" })).toBe("aborted");
    expect(occurrenceTone({ state: "ran", outcome: "succeeded" })).toBe("success");
    expect(occurrenceLabel({ state: "skipped", outcome: null })).toBe("skipped");
    expect(occurrenceTone({ state: "held", outcome: null })).toBe("warning");
  });
});
