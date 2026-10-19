import { expect, test } from "bun:test";
import { definitionForStepSave, definitionFromRecord } from "./workflow-step-editor";

test("step editing preserves every active workflow definition field", () => {
  const original = {
    name: "Briefing",
    execution_privacy: "sensitive",
    required_caller_kind: "user",
    execution_guards: { caller_daily_limit: { limit: 10 } },
    caller_erasure: "on_success",
    input_schema_sample: { mode: "daily" },
    steps: [{ id: "old", kind: "transform" }],
  };
  const steps = [{ id: "head", kind: "request", method: "GET" }];
  expect(definitionFromRecord({ definition: original }, steps)).toEqual({ ...original, steps });
  expect(original.steps).toEqual([{ id: "old", kind: "transform" }]);
});

test("step editing fails closed when the detail response has no definition", () => {
  expect(() => definitionFromRecord({ name: "Briefing", steps: [] }, [])).toThrow(
    "workflow definition is unavailable",
  );
});

test("step editing retains a metadata rename without changing protection fields", () => {
  const definition = {
    name: "Old name",
    slug: "old-name",
    execution_privacy: "sensitive",
    required_caller_kind: "user",
    steps: [{ id: "old", kind: "transform" }],
  };
  expect(
    definitionFromRecord({ name: "New name", slug: "new-name", definition }, definition.steps),
  ).toEqual({ ...definition, name: "New name", slug: "new-name" });
});

test("step editing preserves a cleared metadata description", () => {
  expect(
    definitionFromRecord(
      { description: null, definition: { name: "Briefing", description: "Old", steps: [] } },
      [],
    ),
  ).toEqual({ name: "Briefing", steps: [] });
});

test("step editing a pending draft keeps its reviewed definition", () => {
  const waiting = {
    name: "Draft name",
    execution_privacy: "sensitive",
    steps: [{ id: "draft-step", kind: "transform" }],
  };
  expect(definitionForStepSave({ name: "Active name" }, [], waiting)).toEqual(waiting);
});
