import { describe, expect, test } from "bun:test";
import type { Candidate, TenantFacts } from "./attention-readers.ts";
import { mergePausedSchedules, pausedScheduleCandidate } from "./schedule-pause-attention.ts";

const WORKFLOW = "5eed0002-0000-4000-8000-000000000001";
const OTHER = "5eed0002-0000-4000-8000-000000000002";

const fact = {
  workflow_id: WORKFLOW,
  name: "Mail outbox",
  paused_at: new Date("2026-11-20T08:00:00.000Z"),
  failure_class: "sensitive_execution_failure",
  consecutive_failures: 5,
};

function failing(workflow_id: string): Candidate {
  const candidate = pausedScheduleCandidate({ ...fact, workflow_id });
  return {
    ...candidate,
    source: "failures",
    item: { ...candidate.item, class: "failing", reason: "failing" },
  };
}

function facts(candidates: Candidate[]): TenantFacts {
  return { sources: { schedules: "answered", failures: "answered" }, candidates, status: null };
}

describe("pausedScheduleCandidate", () => {
  test("names the pause, its failure class, since when, and where to resume", () => {
    expect(pausedScheduleCandidate(fact)).toEqual({
      source: "schedules",
      resource: { type: "workflow", id: WORKFLOW },
      item: {
        id: `workflow:${WORKFLOW}`,
        class: "stopped",
        severity: "urgent",
        kind: "workflow",
        subject: { kind: "workflow", id: WORKFLOW, name: "Mail outbox" },
        reason: "schedule_auto_paused",
        trigger: { kind: "schedule", name: null },
        cause_class: null,
        counts: { consecutive_failures: 5 },
        since: "2026-11-20T08:00:00.000Z",
        deadline: null,
        detail: "sensitive_execution_failure",
        actions: [
          {
            verb: "open",
            href: `/cockpit/workflows/${WORKFLOW}#workflow-automation`,
            primary: true,
            permission: "workflow:write",
          },
          expect.objectContaining({ verb: "open_runs", primary: false }),
        ],
      },
    });
  });
});

describe("mergePausedSchedules", () => {
  test("a paused schedule replaces the failing item of its workflow, so there is one item", () => {
    const merged = mergePausedSchedules(facts([failing(WORKFLOW), failing(OTHER)]), [fact]);
    expect(
      merged.candidates.map((candidate) => [candidate.item.id, candidate.item.reason]),
    ).toEqual([
      [`workflow:${OTHER}`, "failing"],
      [`workflow:${WORKFLOW}`, "schedule_auto_paused"],
    ]);
  });

  test("nothing paused leaves the facts untouched", () => {
    const before = facts([failing(WORKFLOW)]);
    expect(mergePausedSchedules(before, [])).toBe(before);
  });
});
