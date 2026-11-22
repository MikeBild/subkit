import { describe, expect, test } from "bun:test";
import {
  TASK_RUN_SEED_SKILL,
  type TaskRunStartFacts,
  taskRunLoadedSkills,
  taskRunSkillSlugs,
  taskRunStart,
  taskRunStarterValid,
} from "./run-start.ts";

const CREATED = new Date("2026-11-19T08:00:00.000Z");
const BEFORE = new Date("2026-11-19T07:59:00.000Z");
const AFTER = new Date("2026-11-19T08:01:00.000Z");

function facts(overrides: Partial<TaskRunStartFacts> = {}): TaskRunStartFacts {
  return {
    state: "running",
    conversation_id: "c1",
    playbook_revision: 1,
    created_at: CREATED,
    ...overrides,
  };
}

describe("taskRunStart", () => {
  test("a run with an attached conversation and a written plan is ready", () => {
    expect(taskRunStart(facts(), AFTER)).toBe("ready");
  });

  test("a run that moved past running is no start any more", () => {
    for (const state of ["waiting", "sleeping", "result_ready", "failed"] as const)
      expect(taskRunStart(facts({ state, conversation_id: null }), AFTER)).toBe("ready");
  });

  const incomplete: Array<[string, Partial<TaskRunStartFacts>]> = [
    ["no conversation", { conversation_id: null, playbook_revision: null }],
    ["a conversation without a plan", { playbook_revision: 0 }],
    ["a conversation that is gone", { playbook_revision: null }],
  ];

  for (const [name, overrides] of incomplete) {
    test(`${name} is still starting inside the window and stalled after it`, () => {
      expect(taskRunStart(facts(overrides), BEFORE)).toBe("starting");
      expect(taskRunStart(facts(overrides), CREATED)).toBe("starting");
      expect(taskRunStart(facts(overrides), AFTER)).toBe("stalled");
    });
  }
});

describe("taskRunSkillSlugs", () => {
  test("the working skill comes first and every slug appears once", () => {
    expect(taskRunSkillSlugs(["report", TASK_RUN_SEED_SKILL, "report"])).toEqual([
      TASK_RUN_SEED_SKILL,
      "report",
    ]);
  });
});

describe("taskRunLoadedSkills", () => {
  const loaded = [{ slug: "baseline", last_turn: 3 }];

  test("active skills join the loaded ones once, at turn zero", () => {
    expect(taskRunLoadedSkills(loaded, ["report", "baseline", "report"])).toEqual([
      { slug: "baseline", last_turn: 3 },
      { slug: "report", last_turn: 0 },
    ]);
  });

  test("nothing to add means nothing to write", () => {
    expect(taskRunLoadedSkills(loaded, [])).toBeNull();
    expect(taskRunLoadedSkills(loaded, ["baseline"])).toBeNull();
  });
});

describe("taskRunStarterValid", () => {
  test("a person starts manual runs and the schedule starts the others", () => {
    expect(taskRunStarterValid("manual", true)).toBe(true);
    expect(taskRunStarterValid("manual", false)).toBe(false);
    expect(taskRunStarterValid("cron", false)).toBe(true);
    expect(taskRunStarterValid("once", true)).toBe(false);
  });
});
