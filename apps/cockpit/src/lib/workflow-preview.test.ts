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
      execution_privacy: "sensitive" as const,
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

  test("an edited draft keeps every field that shapes the saved run", () => {
    const saved = {
      name: "Product briefing",
      product_id: "briefing-app",
      required_caller_kind: "user" as const,
      execution_privacy: "sensitive" as const,
      tool_effect: "read" as const,
      validation_expression: "ok = true",
      output_transform: '{"summary": summary}',
      response_filters: [
        { target: "KEYS" as const, action: "REMOVE" as const, pattern: "^token$" },
      ],
      timeout_ms: 30_000,
      max_llm_tokens_per_run: 4_000,
      runtime: { stdlib_version: "1" },
      execution_guards: { input_bytes: { question: 2_000 } },
      caller_erasure: "on_success" as const,
      steps: [{ id: "old" }],
    };
    const steps = [{ id: "new" }];
    expect(workflowPreviewDefinition(saved, steps)).toEqual({ ...saved, steps });
  });

  test("a definition without a name previews under an empty name", () => {
    const unnamed = { execution_privacy: "sensitive" as const };
    expect(workflowPreviewDefinition(unnamed, [{ id: "a" }])).toEqual({
      ...unnamed,
      name: "",
      steps: [{ id: "a" }],
    });
  });

  test("selected preview input travels with the sensitive draft", () => {
    const definition = {
      name: "Briefing",
      execution_privacy: "sensitive" as const,
      steps: [{ id: "get" }],
    };
    expect(
      workflowPreviewRequest({ source: "draft", definition, input: { mode: "weekly" } }),
    ).toEqual({ source: "draft", definition, input: { mode: "weekly" }, hold_writes: true });
  });
});
