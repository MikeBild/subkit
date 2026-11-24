import { describe, expect, test } from "bun:test";
import {
  assessFailures,
  failureBackoffMs,
  failureClassOf,
  failureStreak,
  type ScheduledRunOutcome,
} from "./failure-backoff.ts";

const NOW = new Date("2026-11-20T10:00:00.000Z");
const MINUTE = 60_000;

function run(
  minutesAgo: number,
  status = "failed",
  error_code: string | null = "sensitive_execution_failure",
  error_message: string | null = null,
): ScheduledRunOutcome {
  return {
    status,
    error_code,
    error_message,
    finished_at: new Date(NOW.getTime() - minutesAgo * MINUTE),
  };
}

describe("failureClassOf", () => {
  test("uses the error code, the timeout status, or a fixed fallback", () => {
    expect(failureClassOf({ status: "failed", error_code: "connector_auth_failed" })).toBe(
      "connector_auth_failed",
    );
    expect(failureClassOf({ status: "timed_out", error_code: "anything" })).toBe("timed_out");
    expect(failureClassOf({ status: "failed", error_code: null })).toBe("unclassified");
    expect(failureClassOf({ status: "failed", error_code: "Free text, not a code" })).toBe(
      "unclassified",
    );
  });
});

describe("failureBackoffMs", () => {
  test("no delay before the third failure, then 2, 6, 18, 54 minutes, capped", () => {
    expect([0, 1, 2].map(failureBackoffMs)).toEqual([0, 0, 0]);
    expect([3, 4, 5, 6].map(failureBackoffMs)).toEqual([2, 6, 18, 54].map((m) => m * MINUTE));
    expect(failureBackoffMs(7)).toBe(54 * MINUTE);
    expect(failureBackoffMs(500)).toBe(54 * MINUTE);
  });
});

describe("failureStreak", () => {
  test("counts the newest failures of one class", () => {
    expect(failureStreak([run(1), run(2), run(3, "succeeded", null), run(4)])).toEqual({
      streak: 2,
      failure_class: "sensitive_execution_failure",
    });
  });

  test("another failure class ends the streak", () => {
    expect(failureStreak([run(1), run(2), run(3, "failed", "http_500"), run(4)]).streak).toBe(2);
  });

  test("the same error code with a different cause ends the streak", () => {
    const runs = [
      run(1, "failed", "http_4xx", "HTTP 403 Forbidden"),
      run(2, "failed", "http_4xx", "HTTP 422 Unprocessable Entity"),
      run(3, "failed", "http_4xx", "HTTP 422 Unprocessable Entity"),
    ];
    expect(failureStreak(runs)).toEqual({ streak: 1, failure_class: "http_4xx" });
    expect(assessFailures(runs, NOW).action).toBe("run");
  });

  test("the same error code with the same cause keeps the streak", () => {
    const runs = [1, 2, 3].map((minutesAgo) =>
      run(minutesAgo, "failed", "http_4xx", "HTTP 422 Unprocessable Entity"),
    );
    expect(failureStreak(runs)).toEqual({ streak: 3, failure_class: "http_4xx" });
    expect(assessFailures(runs, NOW).action).toBe("backoff");
  });

  test("a success or an aborted run on top means no streak", () => {
    expect(failureStreak([run(1, "succeeded", null), run(2), run(3)]).streak).toBe(0);
    expect(failureStreak([run(1, "aborted", null), run(2), run(3)]).streak).toBe(0);
    expect(failureStreak([])).toEqual({ streak: 0, failure_class: null });
  });
});

describe("assessFailures", () => {
  test("two failures still run", () => {
    expect(assessFailures([run(1), run(2)], NOW).action).toBe("run");
  });

  test("three failures wait two minutes after the last one", () => {
    expect(assessFailures([run(1), run(2), run(3)], NOW)).toEqual({
      action: "backoff",
      streak: 3,
      failure_class: "sensitive_execution_failure",
      retry_at: new Date(NOW.getTime() + MINUTE),
    });
    expect(assessFailures([run(2), run(3), run(4)], NOW).action).toBe("run");
  });

  test("four failures wait six minutes", () => {
    expect(assessFailures([run(5), run(6), run(7), run(8)], NOW).action).toBe("backoff");
    expect(assessFailures([run(6), run(7), run(8), run(9)], NOW).action).toBe("run");
  });

  test("five failures of one class pause", () => {
    expect(assessFailures([run(1), run(2), run(3), run(4), run(5)], NOW)).toEqual({
      action: "pause",
      streak: 5,
      failure_class: "sensitive_execution_failure",
    });
  });

  test("five failures of mixed classes do not pause", () => {
    const mixed = [run(60), run(61), run(62, "failed", "http_500"), run(63), run(64)];
    expect(assessFailures(mixed, NOW).action).toBe("run");
  });

  test("a success resets everything", () => {
    const recovered = [run(1, "succeeded", null), run(2), run(3), run(4), run(5), run(6)];
    expect(assessFailures(recovered, NOW)).toEqual({
      action: "run",
      streak: 0,
      failure_class: null,
    });
  });
});
