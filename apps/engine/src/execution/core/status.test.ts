import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  canTransition,
  crashRecoveryOutcome,
  EXECUTION_STATUSES,
  type ExecutionOutcome,
  type ExecutionStatus,
  failureStatusOf,
  isTerminalExecutionStatus,
  NON_TERMINAL_EXECUTION_STATUSES,
  outcomeTransition,
  STEP_STATUSES,
  settledOutcome,
  TERMINAL_EXECUTION_STATUSES,
  transitionSources,
} from "./status.ts";

const FC = { seed: 20261106, numRuns: 200 } as const;
const statusArb = fc.constantFrom(...EXECUTION_STATUSES);

const POLICY = { now_ms: 10_000, default_timeout_ms: 1_000, grace_multiplier: 1.5 };

describe("execution status lists", () => {
  test("terminal and non-terminal partition the execution statuses", () => {
    expect([...NON_TERMINAL_EXECUTION_STATUSES, ...TERMINAL_EXECUTION_STATUSES].sort()).toEqual(
      [...EXECUTION_STATUSES].sort(),
    );
  });

  test("step statuses extend execution statuses with skipped", () => {
    expect(STEP_STATUSES).toEqual([...EXECUTION_STATUSES, "skipped"]);
  });

  test("isTerminalExecutionStatus names the four terminal statuses", () => {
    expect(EXECUTION_STATUSES.filter(isTerminalExecutionStatus)).toEqual([
      "succeeded",
      "failed",
      "aborted",
      "timed_out",
    ]);
  });
});

describe("canTransition", () => {
  test("queued moves to running or any terminal status", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("queued", "aborted")).toBe(true);
    expect(canTransition("queued", "queued")).toBe(false);
  });

  test("running moves only to terminal statuses", () => {
    expect(canTransition("running", "succeeded")).toBe(true);
    expect(canTransition("running", "queued")).toBe(false);
    expect(canTransition("running", "running")).toBe(false);
  });

  test("terminal statuses never transition", () => {
    expect(canTransition("succeeded", "failed")).toBe(false);
  });

  test("the full transition matrix", () => {
    const allowed = EXECUTION_STATUSES.flatMap((from) =>
      EXECUTION_STATUSES.filter((to) => canTransition(from, to)).map((to) => `${from}>${to}`),
    );
    expect(allowed).toEqual([
      "queued>running",
      "queued>succeeded",
      "queued>failed",
      "queued>aborted",
      "queued>timed_out",
      "running>succeeded",
      "running>failed",
      "running>aborted",
      "running>timed_out",
    ]);
  });

  test("property: a terminal status never leaves", () => {
    fc.assert(
      fc.property(statusArb, statusArb, (from, to) => {
        if (isTerminalExecutionStatus(from)) expect(canTransition(from, to)).toBe(false);
      }),
      FC,
    );
  });

  test("property: every transition makes progress and never re-enters queued", () => {
    const rank: Record<ExecutionStatus, number> = {
      queued: 0,
      running: 1,
      succeeded: 2,
      failed: 2,
      aborted: 2,
      timed_out: 2,
    };
    fc.assert(
      fc.property(statusArb, statusArb, (from, to) => {
        if (canTransition(from, to)) {
          expect(rank[to]).toBeGreaterThan(rank[from]);
          expect(to).not.toBe("queued");
        }
      }),
      FC,
    );
  });
});

describe("transitionSources", () => {
  test("defaults to every status that may reach the target", () => {
    expect(transitionSources("failed")).toEqual(["queued", "running"]);
    expect(transitionSources("running")).toEqual(["queued"]);
    expect(transitionSources("queued")).toEqual([]);
  });

  test("narrows an allowed list to legal sources", () => {
    expect(transitionSources("aborted", ["queued"])).toEqual(["queued"]);
    expect(transitionSources("running", ["running", "failed"])).toEqual([]);
  });

  test("property: every returned source can transition and is allowed", () => {
    fc.assert(
      fc.property(statusArb, fc.subarray([...EXECUTION_STATUSES]), (to, allowed) => {
        for (const from of transitionSources(to, allowed)) {
          expect(allowed).toContain(from);
          expect(canTransition(from, to)).toBe(true);
        }
      }),
      FC,
    );
  });
});

describe("failureStatusOf", () => {
  test("keeps aborted and timed_out, maps everything else to failed", () => {
    expect(failureStatusOf("aborted")).toBe("aborted");
    expect(failureStatusOf("timed_out")).toBe("timed_out");
    expect(failureStatusOf("failed")).toBe("failed");
    expect(failureStatusOf("skipped")).toBe("failed");
  });

  test("property: the result is always terminal", () => {
    fc.assert(
      fc.property(fc.constantFrom(...STEP_STATUSES), (status) => {
        expect(isTerminalExecutionStatus(failureStatusOf(status))).toBe(true);
      }),
      FC,
    );
  });
});

describe("crashRecoveryOutcome", () => {
  test("skips a run that never started and has no abort request", () => {
    expect(
      crashRecoveryOutcome(
        { abort_requested: false, started_at_ms: null, workflow_timeout_ms: null },
        POLICY,
      ),
    ).toBeNull();
  });

  test("aborts a requested abort even without a start time", () => {
    expect(
      crashRecoveryOutcome(
        { abort_requested: true, started_at_ms: null, workflow_timeout_ms: null },
        POLICY,
      ),
    ).toEqual({
      status: "aborted",
      reason: "engine_crash_recovery_abort_requested",
      message: "execution abort recovered after worker restart",
      threshold_ms: 1_500,
      age_ms: null,
    });
  });

  test("keeps a young run alive", () => {
    expect(
      crashRecoveryOutcome(
        { abort_requested: false, started_at_ms: 9_000, workflow_timeout_ms: null },
        POLICY,
      ),
    ).toBeNull();
  });

  test("times out a run older than its workflow timeout times the grace", () => {
    expect(
      crashRecoveryOutcome(
        { abort_requested: false, started_at_ms: 0, workflow_timeout_ms: 2_000 },
        POLICY,
      ),
    ).toEqual({
      status: "timed_out",
      reason: "engine_crash_recovery",
      message: "execution timeout recovered after worker restart",
      threshold_ms: 3_000,
      age_ms: 10_000,
    });
  });

  test("times out a run exactly at its threshold", () => {
    expect(
      crashRecoveryOutcome(
        { abort_requested: false, started_at_ms: 8_500, workflow_timeout_ms: null },
        POLICY,
      ),
    ).toEqual({
      status: "timed_out",
      reason: "engine_crash_recovery",
      message: "execution timeout recovered after worker restart",
      threshold_ms: 1_500,
      age_ms: 1_500,
    });
  });

  test("never times out a run without a start time, even at a zero threshold", () => {
    expect(
      crashRecoveryOutcome(
        { abort_requested: false, started_at_ms: null, workflow_timeout_ms: null },
        { ...POLICY, override_threshold_ms: 0 },
      ),
    ).toBeNull();
    expect(
      crashRecoveryOutcome(
        { abort_requested: false, started_at_ms: null, workflow_timeout_ms: null },
        { ...POLICY, override_threshold_ms: -1 },
      ),
    ).toBeNull();
  });

  test("an override threshold replaces the derived one", () => {
    expect(
      crashRecoveryOutcome(
        { abort_requested: false, started_at_ms: 9_990, workflow_timeout_ms: 2_000 },
        { ...POLICY, override_threshold_ms: 5 },
      )?.threshold_ms,
    ).toBe(5);
  });

  test("property: an abort request always recovers as aborted", () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 0, max: 20_000 }), { nil: null }),
        fc.option(fc.integer({ min: 1, max: 20_000 }), { nil: null }),
        (started, timeout) => {
          expect(
            crashRecoveryOutcome(
              { abort_requested: true, started_at_ms: started, workflow_timeout_ms: timeout },
              POLICY,
            )?.status,
          ).toBe("aborted");
        },
      ),
      FC,
    );
  });

  test("property: a timeout outcome is never younger than its threshold", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20_000 }),
        fc.option(fc.integer({ min: 1, max: 20_000 }), { nil: null }),
        (started, timeout) => {
          const outcome = crashRecoveryOutcome(
            { abort_requested: false, started_at_ms: started, workflow_timeout_ms: timeout },
            POLICY,
          );
          if (outcome) expect(outcome.age_ms ?? -1).toBeGreaterThanOrEqual(outcome.threshold_ms);
        },
      ),
      FC,
    );
  });
});

const OUTCOMES: ExecutionOutcome[] = [
  { type: "completed" },
  { type: "failed" },
  { type: "aborted" },
  { type: "timed_out" },
  { type: "enqueue_failed" },
  { type: "admission_failed", refused: false },
  { type: "admission_failed", refused: true },
  { type: "cancelled" },
];

describe("outcomeTransition", () => {
  test("maps every outcome to its terminal status, sources and event", () => {
    expect(OUTCOMES.map(outcomeTransition)).toEqual([
      {
        status: "succeeded",
        sources: ["queued", "running"],
        refused: false,
        event_type: "execution.succeeded",
      },
      {
        status: "failed",
        sources: ["queued", "running"],
        refused: false,
        event_type: "execution.failed",
      },
      {
        status: "aborted",
        sources: ["queued", "running"],
        refused: false,
        event_type: "execution.aborted",
      },
      {
        status: "timed_out",
        sources: ["queued", "running"],
        refused: false,
        event_type: "execution.timed_out",
      },
      { status: "failed", sources: ["queued"], refused: false, event_type: "execution.failed" },
      { status: "failed", sources: ["queued"], refused: false, event_type: "execution.failed" },
      { status: "failed", sources: ["queued"], refused: true, event_type: "execution.refused" },
      { status: "aborted", sources: ["queued"], refused: false, event_type: "execution.aborted" },
    ]);
  });

  test("property: every source may legally reach the outcome status", () => {
    fc.assert(
      fc.property(fc.constantFrom(...OUTCOMES), (outcome) => {
        const transition = outcomeTransition(outcome);
        expect(isTerminalExecutionStatus(transition.status)).toBe(true);
        expect(transition.sources.length).toBeGreaterThan(0);
        for (const from of transition.sources) {
          expect(canTransition(from, transition.status)).toBe(true);
          expect(NON_TERMINAL_EXECUTION_STATUSES as readonly ExecutionStatus[]).toContain(from);
        }
        expect(transition.refused).toBe(transition.event_type === "execution.refused");
      }),
      FC,
    );
  });
});

describe("settledOutcome", () => {
  test("names the outcome for each terminal status", () => {
    expect(TERMINAL_EXECUTION_STATUSES.map(settledOutcome)).toEqual([
      { type: "completed" },
      { type: "failed" },
      { type: "aborted" },
      { type: "timed_out" },
    ]);
  });

  test("a non-terminal status settles as failed", () => {
    expect(NON_TERMINAL_EXECUTION_STATUSES.map(settledOutcome)).toEqual([
      { type: "failed" },
      { type: "failed" },
    ]);
  });

  test("property: a settled outcome round-trips to its status", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TERMINAL_EXECUTION_STATUSES), (status) => {
        expect(outcomeTransition(settledOutcome(status)).status).toBe(status);
      }),
      FC,
    );
  });
});
