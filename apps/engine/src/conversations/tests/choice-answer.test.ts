import { expect, test } from "bun:test";
import { resolvedChoiceAnswer } from "../prose-question-answer.ts";

const row = {
  tool_name: "ask_user_choice",
  status: "resolved" as const,
  input: {
    options: [
      { value: "dryrun", label: "Vorschau prüfen" },
      { value: "cancel", label: "Abbrechen" },
    ],
  },
  output: { value: "dryrun" },
};
test("completed choice displays the declared human label", () => {
  expect(resolvedChoiceAnswer(row)).toBe("Vorschau prüfen");
});
test("unanswered, cancelled, unknown and other question types are not completed choices", () => {
  expect(resolvedChoiceAnswer({ ...row, status: "pending" })).toBeNull();
  expect(resolvedChoiceAnswer({ ...row, status: "cancelled" })).toBeNull();
  expect(resolvedChoiceAnswer({ ...row, output: { value: "invented" } })).toBeNull();
  expect(resolvedChoiceAnswer({ ...row, tool_name: "ask_user_confirm" })).toBeNull();
});
