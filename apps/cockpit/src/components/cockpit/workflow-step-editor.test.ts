import { expect, test } from "bun:test";
import { definitionFromRecord } from "./workflow-step-editor";

test("editing an active sensitive workflow keeps its privacy and input contract", () => {
  const input_schema = {
    type: "object",
    properties: { mode: { type: "string", enum: ["daily", "weekly"] } },
  };
  const steps = [{ id: "head", kind: "request", method: "GET" }];
  expect(
    definitionFromRecord(
      { name: "Briefing", execution_privacy: "sensitive", input_schema, steps: [] },
      steps,
    ),
  ).toMatchObject({ execution_privacy: "sensitive", input_schema, steps });
  expect(
    definitionFromRecord(
      { definition: { name: "Briefing", execution_privacy: "sensitive", input_schema } },
      steps,
    ),
  ).toMatchObject({ execution_privacy: "sensitive", input_schema, steps });
});
