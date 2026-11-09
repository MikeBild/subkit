import { expect, test } from "bun:test";
import type { z } from "@hono/zod-openapi";
import type { DomainWorkflowDef } from "./domain-types.ts";
import { buildStepTopology } from "./prior-workflows.ts";
import { type WorkflowDef, WorkflowDefSchema } from "./types.ts";

function acceptsDomainDefinition(_definition: DomainWorkflowDef): void {}

test("boundary parser output remains assignable to the pure workflow graph model", () => {
  const parsed: WorkflowDef = WorkflowDefSchema.parse({
    name: "contract",
    steps: [{ id: "result", kind: "transform", expression: "return {};" }],
  });
  acceptsDomainDefinition(parsed);
  expect(parsed.steps[0]?.kind).toBe("transform");
});

test("rich domain step variants remain accepted by the Zod/OpenAPI boundary", () => {
  const definition = {
    name: "all-domain-variants",
    steps: [
      { id: "request", kind: "request", method: "POST", url: "https://example.test" },
      { id: "transform", kind: "transform", language: "javascript", expression: "return {};" },
      { id: "call", kind: "call", workflow_slug: "another-workflow" },
      { id: "wait", kind: "wait", duration_ms: 0 },
      { id: "event", kind: "wait_for_event", event_name: "done", timeout_ms: 1000 },
      { id: "branch", kind: "branch", when: "true", then_steps: [] },
      { id: "parallel", kind: "parallel", branches: [[]] },
      { id: "loop", kind: "loop", over: "items", body: [] },
    ],
  } satisfies DomainWorkflowDef;

  const boundaryInput: z.input<typeof WorkflowDefSchema> = definition;
  const parsed: WorkflowDef = WorkflowDefSchema.parse(definition);
  acceptsDomainDefinition(parsed);
  expect(WorkflowDefSchema.parse(boundaryInput).steps).toHaveLength(definition.steps.length);
});

test("domain topology preserves request verbs before and after boundary parsing", () => {
  for (const method of [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
    "LIST",
    "SELECT",
    "INSERT",
    "UPDATE",
    "CALL",
  ] as const) {
    const connector_id = "00000000-0000-4000-8000-000000000123";
    const driver =
      method === "LIST"
        ? { s3: { prefix: "records/" } }
        : ["SELECT", "INSERT", "UPDATE", "CALL"].includes(method)
          ? { sql: { query: "SELECT 1" } }
          : {};
    const definition = {
      name: "method-contract",
      steps: [
        { id: "request", kind: "request", method, connector_id, path: "/records", ...driver },
      ],
    } satisfies DomainWorkflowDef;
    const expected = [{ kind: "request", connector_id, action: `${method} /records` }];
    expect(buildStepTopology(definition)).toEqual(expected);
    expect(buildStepTopology(WorkflowDefSchema.parse(definition))).toEqual(expected);
  }
});
