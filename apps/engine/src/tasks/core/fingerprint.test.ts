import { describe, expect, test } from "bun:test";
import {
  type TaskFingerprintSource,
  taskFingerprint,
  taskFingerprintContent,
} from "./fingerprint.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

function source(overrides: Partial<TaskFingerprintSource> = {}): TaskFingerprintSource {
  return {
    goal: "Send the weekly report",
    done_when: "The report is in the inbox",
    plan: { title: "Report", steps: [{ id: "collect" }] },
    bindings: {
      workflow_ids: [B, A],
      connector_ids: [B, A],
      skill_slugs: ["b", "a"],
      web_search: false,
    },
    environment: "prod",
    schedule_cron: "0 8 * * 1",
    schedule_timezone: "Europe/Berlin",
    schedule_run_at: null,
    max_turns: 20,
    run_deadline_minutes: 240,
    owner_id: A,
    ...overrides,
  };
}

describe("taskFingerprint", () => {
  test("is a sha256 digest of exactly the canonical content", () => {
    expect(taskFingerprint(source())).toMatch(/^[0-9a-f]{64}$/);
    expect(taskFingerprintContent(source())).toEqual({
      goal: "Send the weekly report",
      done_when: "The report is in the inbox",
      plan: { title: "Report", steps: [{ id: "collect" }] },
      bindings: {
        workflow_ids: [A, B],
        connector_ids: [A, B],
        skill_slugs: ["a", "b"],
        web_search: false,
      },
      environment: "prod",
      schedule_cron: "0 8 * * 1",
      schedule_timezone: "Europe/Berlin",
      schedule_run_at: null,
      max_turns: 20,
      run_deadline_minutes: 240,
      owner_id: A,
    });
  });

  test("ignores name, description, category and the order of bindings", () => {
    const extra = { ...source(), name: "A", description: "B", category: "c" };
    const reordered = source({
      bindings: {
        workflow_ids: [A, B],
        connector_ids: [A, B],
        skill_slugs: ["a", "b"],
        web_search: false,
      },
    });
    expect(taskFingerprint(extra)).toBe(taskFingerprint(source()));
    expect(taskFingerprint(reordered)).toBe(taskFingerprint(source()));
  });

  test("does not reorder the caller's bindings", () => {
    const input = source();
    taskFingerprint(input);
    expect(input.bindings.workflow_ids).toEqual([B, A]);
    expect(input.bindings.connector_ids).toEqual([B, A]);
    expect(input.bindings.skill_slugs).toEqual(["b", "a"]);
  });

  test("treats the same instant in another notation as equal", () => {
    const utc = source({ schedule_cron: null, schedule_run_at: "2026-12-01T08:00:00.000Z" });
    const offset = source({ schedule_cron: null, schedule_run_at: "2026-12-01T09:00:00+01:00" });
    expect(taskFingerprintContent(offset).schedule_run_at).toBe("2026-12-01T08:00:00.000Z");
    expect(taskFingerprint(offset)).toBe(taskFingerprint(utc));
  });

  const changes: Array<[string, Partial<TaskFingerprintSource>]> = [
    ["goal", { goal: "Other" }],
    ["done_when", { done_when: "Other" }],
    ["plan", { plan: { title: "Other" } }],
    ["workflow binding", { bindings: { ...source().bindings, workflow_ids: [A] } }],
    ["connector binding", { bindings: { ...source().bindings, connector_ids: [A] } }],
    ["skill binding", { bindings: { ...source().bindings, skill_slugs: ["a"] } }],
    ["web search", { bindings: { ...source().bindings, web_search: true } }],
    ["environment", { environment: "dev" }],
    ["cron", { schedule_cron: "0 9 * * 1" }],
    ["timezone", { schedule_timezone: "UTC" }],
    ["run at", { schedule_cron: null, schedule_run_at: "2026-12-01T08:00:00.000Z" }],
    ["max turns", { max_turns: 21 }],
    ["deadline", { run_deadline_minutes: 241 }],
    ["owner", { owner_id: B }],
  ];
  for (const [label, change] of changes)
    test(`changes with the ${label}`, () => {
      expect(taskFingerprint(source(change))).not.toBe(taskFingerprint(source()));
    });
});
