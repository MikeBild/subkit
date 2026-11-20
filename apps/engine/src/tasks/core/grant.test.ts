import { describe, expect, test } from "bun:test";
import {
  isTaskGrantExpiringSoon,
  isTaskGrantLive,
  type TaskGrantFacts,
  taskGrantRemainingRuns,
  taskGrantStatus,
} from "./grant.ts";

const NOW = new Date("2026-11-19T08:00:00.000Z");
const DAY = 86_400_000;
const PRINT = "a".repeat(64);
const at = (offset: number) => new Date(NOW.getTime() + offset);

function grant(overrides: Partial<TaskGrantFacts> = {}): TaskGrantFacts {
  return {
    fingerprint: PRINT,
    valid_from: at(-DAY),
    valid_until: null,
    max_runs: null,
    reserved_runs: 0,
    revoked_at: null,
    ...overrides,
  };
}

describe("taskGrantStatus", () => {
  const cases: Array<
    [string, Partial<TaskGrantFacts>, string, ReturnType<typeof taskGrantStatus>]
  > = [
    ["open-ended", {}, PRINT, "live"],
    ["valid from now", { valid_from: NOW }, PRINT, "live"],
    ["revoked", { revoked_at: at(-1) }, PRINT, "revoked"],
    ["revoked wins over a changed task", { revoked_at: at(-1) }, "b".repeat(64), "revoked"],
    ["changed task", {}, "b".repeat(64), "fingerprint_mismatch"],
    [
      "changed task wins over expiry",
      { valid_until: at(-1) },
      "b".repeat(64),
      "fingerprint_mismatch",
    ],
    ["starts later", { valid_from: at(1) }, PRINT, "not_yet_valid"],
    [
      "starts later wins over expiry",
      { valid_from: at(1), valid_until: at(-1) },
      PRINT,
      "not_yet_valid",
    ],
    ["ends now", { valid_until: NOW }, PRINT, "expired"],
    ["ended", { valid_until: at(-1) }, PRINT, "expired"],
    [
      "expiry wins over used runs",
      { valid_until: at(-1), max_runs: 1, reserved_runs: 1 },
      PRINT,
      "expired",
    ],
    ["ends later", { valid_until: at(1) }, PRINT, "live"],
    ["runs used", { max_runs: 2, reserved_runs: 2 }, PRINT, "exhausted"],
    ["one run left", { max_runs: 2, reserved_runs: 1 }, PRINT, "live"],
  ];
  for (const [label, facts, print, expected] of cases)
    test(label, () => {
      expect(taskGrantStatus(grant(facts), print, NOW)).toBe(expected);
      expect(isTaskGrantLive(grant(facts), print, NOW)).toBe(expected === "live");
    });
});

describe("taskGrantRemainingRuns", () => {
  test("counts down and never goes negative", () => {
    expect(taskGrantRemainingRuns(grant())).toBeNull();
    expect(taskGrantRemainingRuns(grant({ max_runs: 5, reserved_runs: 2 }))).toBe(3);
    expect(taskGrantRemainingRuns(grant({ max_runs: 5, reserved_runs: 9 }))).toBe(0);
  });
});

describe("isTaskGrantExpiringSoon", () => {
  const cases: Array<[string, Partial<TaskGrantFacts>, boolean]> = [
    ["open-ended", {}, false],
    ["ends in exactly seven days", { valid_until: at(7 * DAY) }, true],
    ["ends a moment after seven days", { valid_until: at(7 * DAY + 1) }, false],
    ["ends in three days", { valid_until: at(3 * DAY) }, true],
    ["ends tomorrow", { valid_until: at(DAY) }, true],
    ["exactly a tenth of the runs left", { max_runs: 10, reserved_runs: 9 }, false],
    ["under a tenth of the runs left", { max_runs: 20, reserved_runs: 19 }, true],
    ["plenty of runs", { max_runs: 20, reserved_runs: 1 }, false],
    [
      "few runs but ends far away",
      { valid_until: at(30 * DAY), max_runs: 20, reserved_runs: 19 },
      true,
    ],
    [
      "ends soon with plenty of runs",
      { valid_until: at(DAY), max_runs: 20, reserved_runs: 1 },
      true,
    ],
    ["not live anymore", { valid_until: at(-1) }, false],
    ["revoked", { valid_until: at(DAY), revoked_at: at(-1) }, false],
  ];
  for (const [label, facts, expected] of cases)
    test(label, () => {
      expect(isTaskGrantExpiringSoon(grant(facts), PRINT, NOW)).toBe(expected);
    });

  test("a changed task is not reported as expiring", () => {
    expect(isTaskGrantExpiringSoon(grant({ valid_until: at(DAY) }), "b".repeat(64), NOW)).toBe(
      false,
    );
  });
});
