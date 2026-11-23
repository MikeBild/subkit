import { expect, test } from "bun:test";
import { stepPhrase } from "@/features/workflows/model/workflow-flow";
import { readStepDefinition } from "@/features/workflows/model/workflow-steps";

test("a model step reads as asking the AI, with or without a named service", () => {
  const definition = readStepDefinition({ id: "m", kind: "model", prompt: "Summarise" }, 0);
  expect(stepPhrase(definition, null)).toEqual({ key: "workflowFlow.step.model" });
  expect(stepPhrase(definition, "Mail")).toEqual({ key: "workflowFlow.step.model" });
});

test("a step of the removed loop kind falls back to the neutral phrase", () => {
  const definition = readStepDefinition({ id: "l", kind: "loop", over: "x", body: [] }, 0);
  expect(stepPhrase(definition, null)).toEqual({ key: "workflowFlow.step.other" });
});

test("a request that is not plain HTTP reads as using the service", () => {
  const sql = readStepDefinition(
    { id: "q", kind: "request", protocol: "sql", sql: { query: "select 1" } },
    0,
  );
  expect(stepPhrase(sql, "Warehouse")).toEqual({
    key: "workflowFlow.step.uses",
    values: { service: "Warehouse" },
  });
  expect(stepPhrase(sql, null)).toEqual({ key: "workflowFlow.step.usesAny" });
});
