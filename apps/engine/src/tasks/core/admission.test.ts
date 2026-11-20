import { describe, expect, test } from "bun:test";
import type { TaskAdmissionReason } from "../types.ts";
import {
  decideTaskAdmission,
  type TaskAdmissionFacts,
  taskTriggerNeedsGrant,
} from "./admission.ts";
import type { TaskGrantFacts } from "./grant.ts";

const NOW = new Date("2026-11-19T08:00:00.000Z");
const PRINT = "a".repeat(64);
const at = (offset: number) => new Date(NOW.getTime() + offset);

function grant(overrides: Partial<TaskGrantFacts> = {}): TaskGrantFacts {
  return {
    fingerprint: PRINT,
    valid_from: at(-1000),
    valid_until: null,
    max_runs: null,
    reserved_runs: 0,
    revoked_at: null,
    ...overrides,
  };
}

function facts(overrides: Partial<TaskAdmissionFacts> = {}): TaskAdmissionFacts {
  return {
    task: { paused: false, fingerprint: PRINT },
    owner: { active: true, permitted: true },
    ai_access: true,
    previous_run_active: false,
    trigger: "cron",
    grant: grant(),
    ...overrides,
  };
}

const blocked: TaskAdmissionFacts = {
  task: { paused: true, fingerprint: PRINT },
  owner: { active: false, permitted: false },
  ai_access: false,
  previous_run_active: true,
  trigger: "cron",
  grant: null,
};

describe("decideTaskAdmission", () => {
  test("admits a scheduled run with a live grant", () => {
    expect(decideTaskAdmission(facts(), NOW)).toEqual({ admit: true });
    expect(decideTaskAdmission(facts({ trigger: "once" }), NOW)).toEqual({ admit: true });
  });

  test("a person may start without a grant", () => {
    expect(decideTaskAdmission(facts({ trigger: "manual", grant: null }), NOW)).toEqual({
      admit: true,
    });
    expect(
      decideTaskAdmission(facts({ trigger: "manual", grant: grant({ revoked_at: at(-1) }) }), NOW),
    ).toEqual({ admit: true });
  });

  const reasons: Array<[string, Partial<TaskAdmissionFacts>, TaskAdmissionReason]> = [
    ["paused", { task: { paused: true, fingerprint: PRINT } }, "paused"],
    ["owner inactive", { owner: { active: false, permitted: true } }, "owner_unavailable"],
    [
      "owner lost the permission",
      { owner: { active: true, permitted: false } },
      "owner_unavailable",
    ],
    ["no AI access", { ai_access: false }, "ai_access_missing"],
    ["earlier run open", { previous_run_active: true }, "previous_run_active"],
    ["no grant", { grant: null }, "grant_required"],
    ["one-time start without a grant", { trigger: "once", grant: null }, "grant_required"],
    ["revoked grant", { grant: grant({ revoked_at: at(-1) }) }, "grant_required"],
    ["grant starts later", { grant: grant({ valid_from: at(1) }) }, "grant_required"],
    ["grant expired", { grant: grant({ valid_until: at(-1) }) }, "grant_expired"],
    ["grant used up", { grant: grant({ max_runs: 1, reserved_runs: 1 }) }, "grant_exhausted"],
    [
      "task changed",
      { grant: grant({ fingerprint: "b".repeat(64) }) },
      "grant_fingerprint_mismatch",
    ],
  ];
  for (const [label, change, reason] of reasons)
    test(`refuses: ${label}`, () => {
      expect(decideTaskAdmission(facts(change), NOW)).toEqual({ admit: false, reason });
    });

  test("reports the first reason in a fixed order", () => {
    const order: TaskAdmissionReason[] = [
      "paused",
      "owner_unavailable",
      "ai_access_missing",
      "previous_run_active",
      "grant_required",
    ];
    const steps: Array<Partial<TaskAdmissionFacts>> = [
      {},
      { task: { paused: false, fingerprint: PRINT } },
      { owner: { active: true, permitted: true } },
      { ai_access: true },
      { previous_run_active: false },
    ];
    let current = blocked;
    for (const [index, reason] of order.entries()) {
      current = { ...current, ...steps[index] };
      expect(decideTaskAdmission(current, NOW)).toEqual({ admit: false, reason });
    }
  });

  test("a manual start still respects every other reason", () => {
    expect(decideTaskAdmission({ ...blocked, trigger: "manual" }, NOW)).toEqual({
      admit: false,
      reason: "paused",
    });
    expect(
      decideTaskAdmission(
        facts({ trigger: "manual", previous_run_active: true, grant: null }),
        NOW,
      ),
    ).toEqual({ admit: false, reason: "previous_run_active" });
  });
});

describe("taskTriggerNeedsGrant", () => {
  test("only starts by a person need none", () => {
    expect(taskTriggerNeedsGrant("manual")).toBe(false);
    expect(taskTriggerNeedsGrant("once")).toBe(true);
    expect(taskTriggerNeedsGrant("cron")).toBe(true);
  });
});
