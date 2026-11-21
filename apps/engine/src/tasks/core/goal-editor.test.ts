import { describe, expect, test } from "bun:test";
import { goalWriterId, nextGoalEditor, ownerWroteGoal } from "./goal-editor.ts";

const OWNER = "00000000-0000-4000-8000-000000000001";
const ADMIN = "00000000-0000-4000-8000-000000000002";
const prior = { goal: "Sort the inbox", done_when: "Inbox is empty", goal_edited_by: OWNER };
const owner = { kind: "user", id: OWNER, auth_source: { kind: "browser_session" } };
const admin = { kind: "user", id: ADMIN };

describe("who wrote a task's goal", () => {
  test("a person writes the goal in their own name", () => {
    expect(goalWriterId(owner)).toBe(OWNER);
    expect(goalWriterId(admin)).toBe(ADMIN);
  });

  test("a task run, a system account or no principal writes nobody's words", () => {
    expect(goalWriterId({ ...owner, auth_source: { kind: "task_run" } })).toBeNull();
    expect(goalWriterId({ kind: "system_account", id: OWNER })).toBeNull();
    expect(goalWriterId(null)).toBeNull();
  });

  test("changing the goal makes the writer its last editor", () => {
    expect(nextGoalEditor(prior, { ...prior, goal: "Sort and archive" }, admin)).toBe(ADMIN);
  });

  test("changing the done-when text makes the writer its last editor", () => {
    expect(nextGoalEditor(prior, { ...prior, done_when: "Nothing left" }, admin)).toBe(ADMIN);
  });

  test("leaving both texts as they were keeps the last editor", () => {
    expect(nextGoalEditor(prior, { goal: prior.goal, done_when: prior.done_when }, admin)).toBe(
      OWNER,
    );
    expect(nextGoalEditor({ ...prior, goal_edited_by: ADMIN }, { ...prior }, owner)).toBe(ADMIN);
  });

  test("the owner's own edit after someone else's restores the owner as editor", () => {
    const edited = { ...prior, goal: "Sort and archive", goal_edited_by: ADMIN };
    expect(nextGoalEditor(edited, { ...edited, goal: "Sort only" }, owner)).toBe(OWNER);
  });

  test("only the owner as last editor counts as the owner's words", () => {
    expect(ownerWroteGoal(OWNER, OWNER)).toBe(true);
    expect(ownerWroteGoal(OWNER, ADMIN)).toBe(false);
    expect(ownerWroteGoal(OWNER, null)).toBe(false);
  });
});
