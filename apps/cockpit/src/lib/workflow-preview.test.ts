import { describe, expect, test } from "bun:test";
import { workflowPreviewDefinition, workflowPreviewRequest } from "./workflow-preview";

describe("cockpit workflow previews", () => {
  test("whole workflow and step requests always hold writes", () => {
    const step = { id: "send", kind: "request", method: "POST" };
    const definition = { name: "Example", steps: [step] };
    expect(workflowPreviewRequest({ source: "draft", definition })).toEqual({
      source: "draft",
      definition,
      hold_writes: true,
    });
    expect(workflowPreviewRequest({ source: "step", step })).toEqual({
      source: "step",
      step,
      hold_writes: true,
    });
  });

  test("an edited draft retains privacy and input contracts", () => {
    const saved = {
      name: "Private briefing",
      execution_privacy: "sensitive",
      input_schema: { type: "object", properties: { mode: { enum: ["daily", "weekly"] } } },
      output_schema: { type: "object" },
      steps: [{ id: "old" }],
    };
    const steps = [{ id: "new" }];
    expect(
      workflowPreviewRequest({
        source: "draft",
        definition: workflowPreviewDefinition(saved, steps),
      }),
    ).toEqual({
      source: "draft",
      definition: { ...saved, steps },
      hold_writes: true,
    });
  });
});
