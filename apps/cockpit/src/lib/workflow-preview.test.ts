import { describe, expect, test } from "bun:test";
import { workflowPreviewRequest, workflowPreviewSucceeded } from "./workflow-preview";

describe("cockpit workflow previews", () => {
  test("whole workflow and step requests always hold writes", () => {
    const step = { id: "send", kind: "request", method: "POST" };
    const definition = { name: "Example", steps: [step] };
    expect(workflowPreviewRequest({ source: "draft", definition })).toEqual({
      source: "draft",
      definition,
      request_source: "api",
      hold_writes: true,
    });
    expect(workflowPreviewRequest({ source: "step", step })).toEqual({
      source: "step",
      step,
      request_source: "api",
      hold_writes: true,
    });
  });

  test("does not render a failed or unknown workflow result as success", () => {
    expect(workflowPreviewSucceeded({ status: "succeeded" })).toBe(true);
    for (const status of ["failed", "queued", "cancelled", "unknown", undefined]) {
      expect(workflowPreviewSucceeded({ status })).toBe(false);
    }
  });
});
