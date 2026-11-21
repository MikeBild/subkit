import { describe, expect, test } from "bun:test";
import { checklistView, startStepIcon } from "@/features/first-steps/model/first-steps";

describe("first steps", () => {
  test("counts what is done, names the next step and the share for the bar", () => {
    const view = checklistView(
      [{ done: true }, { done: false }, { done: false }, { done: true }],
      false,
    );
    expect(view).toEqual({ visible: true, done: 2, total: 4, percent: 50, next: 1 });
  });

  test("hides once hidden, empty or complete", () => {
    expect(checklistView([{ done: false }], true).visible).toBe(false);
    expect(checklistView([], false).visible).toBe(false);
    expect(checklistView([{ done: true }], false).visible).toBe(false);
  });

  test("every known step has its own icon, an unknown one gets the plug", () => {
    expect(
      ["connector", "first-job", "run", "people", "client"].map((id) => startStepIcon(id)),
    ).toEqual(["plug", "message", "play", "users", "terminal"]);
    expect(startStepIcon("later")).toBe("plug");
    expect(startStepIcon(undefined)).toBe("plug");
  });
});
