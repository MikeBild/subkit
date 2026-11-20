import { describe, expect, test } from "bun:test";
import {
  asksForTheTaskRunResult,
  normalizeTaskRunQuestion,
  stepHoldsDeliveredResult,
  TASK_RUN_RESULT_STEP_ID,
  taskRunQuestionStaysOpen,
} from "./task-run-result.ts";

const GOAL = "Fasse das Wetter in Berlin zusammen";

describe("stepHoldsDeliveredResult", () => {
  test.each([
    ["blocked", "conversation", true],
    ["blocked", "task_run", true],
    ["waiting_for_input", "conversation", true],
    ["waiting_for_input", "task_run", false],
    ["open", "conversation", false],
    ["open", "task_run", false],
    ["in_progress", "task_run", false],
    ["verified", "conversation", false],
  ] as const)("%s in a %s holds the result: %p", (progress, handOver, held) => {
    expect(stepHoldsDeliveredResult(progress, handOver)).toBe(held);
  });
});

describe("normalizeTaskRunQuestion", () => {
  test.each([
    [GOAL, "fasse das wetter in berlin zusammen"],
    [`  ${GOAL.toUpperCase()}?  `, "fasse das wetter in berlin zusammen"],
    ["Fasse  das\n\tWetter in Berlin zusammen …", "fasse das wetter in berlin zusammen"],
    [`${GOAL}!?.`, "fasse das wetter in berlin zusammen"],
    [`${GOAL} :;,`, "fasse das wetter in berlin zusammen"],
    ["ＦＡＳＳＥ", "fasse"],
    ["Is it 3.8?", "is it 3.8"],
    ["?Why", "?why"],
    ["", null],
    ["   ", null],
    ["?!.", null],
    [7, null],
    [null, null],
    [undefined, null],
  ] as const)("%p -> %p", (text, normalized) => {
    expect(normalizeTaskRunQuestion(text)).toBe(normalized);
  });
});

describe("asksForTheTaskRunResult", () => {
  const reserved = { goal: GOAL, result_question: "Ist das Ergebnis richtig?" };
  test.each([
    [{ playbook_step_id: TASK_RUN_RESULT_STEP_ID }, true],
    [{ playbook_step_id: TASK_RUN_RESULT_STEP_ID, question: "Welche Liste?" }, true],
    [{ question: GOAL }, true],
    [{ question: `  ${GOAL.toLowerCase()}?` }, true],
    [{ question: "ist das ergebnis richtig" }, true],
    [{ question: "Welche Liste?" }, false],
    [{ question: `${GOAL} für wen?` }, false],
    [{ playbook_step_id: "work", question: "Welche Liste?" }, false],
    [{ question: "" }, false],
    [{ question: 7 }, false],
    [{}, false],
  ])("%j: %p", (ask, refused) => {
    expect(asksForTheTaskRunResult(ask, reserved)).toBe(refused);
  });

  test("with nothing reserved only the binding to the result step counts", () => {
    const none = { goal: null, result_question: null };
    expect(asksForTheTaskRunResult({ playbook_step_id: TASK_RUN_RESULT_STEP_ID }, none)).toBe(true);
    expect(asksForTheTaskRunResult({ question: GOAL }, none)).toBe(false);
    expect(asksForTheTaskRunResult({ question: "" }, { goal: "", result_question: "" })).toBe(
      false,
    );
    expect(asksForTheTaskRunResult({ question: GOAL }, { goal: null, result_question: GOAL })).toBe(
      true,
    );
  });
});

describe("taskRunQuestionStaysOpen", () => {
  const approval = { question: "Perform the held writes?", commit_intent: { kind: "x" } };
  test.each([
    [approval, "result_ready", true],
    [approval, "ended", false],
    [{ question: GOAL }, "result_ready", false],
    [{ question: "Welche Liste?" }, "result_ready", false],
    [{ commit_intent: null }, "result_ready", true],
    [{ commit_intent: undefined }, "result_ready", false],
    [null, "result_ready", false],
    ["text", "result_ready", false],
    [undefined, "ended", false],
    [undefined, "result_ready", false],
    [7, "result_ready", false],
  ] as const)("%j at %s stays open: %p", (input, outcome, open) => {
    expect(taskRunQuestionStaysOpen(input, outcome)).toBe(open);
  });
});
