import { expect, test } from "bun:test";
import { isWorkflowInputForm } from "./commit-intent.ts";

test("only handle-free workflow input forms are data rather than approval decisions", () => {
  const form = { commit_intent: { kind: "run_workflow", payload: { execute_writes: true } } };
  expect(isWorkflowInputForm("ask_user_form", form)).toBe(true);
  expect(isWorkflowInputForm("ask_user_confirm", form)).toBe(false);
  expect(
    isWorkflowInputForm("ask_user_form", {
      commit_intent: { kind: "run_workflow", payload: { approval_id: "pending-handle" } },
    }),
  ).toBe(false);
  expect(isWorkflowInputForm("ask_user_form", { commit_intent: { kind: "delete_workflow" } })).toBe(
    false,
  );
  for (const input of [undefined, null, "run_workflow", [], {}, { commit_intent: [] }]) {
    expect(isWorkflowInputForm("ask_user_form", input)).toBe(false);
  }
});
