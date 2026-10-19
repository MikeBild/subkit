import { expect, test } from "bun:test";
import type { WorkflowView } from "../../workflows/index.ts";
import { serializeWorkflowDetail, WorkflowDetailSchema } from "./workflow-representation.ts";

test("workflow detail exposes the full active definition for a safe draft edit", () => {
  const definition = {
    name: "Briefing",
    execution_privacy: "sensitive",
    required_caller_kind: "user",
    caller_erasure: "on_success",
    steps: [{ id: "mail", kind: "transform", code: "return {};" }],
  };
  const instant = new Date("2020-01-01T00:00:00.000Z");
  const workflow = {
    id: "workflow",
    tenant_id: "tenant",
    slug: "briefing",
    name: "Briefing",
    category: "other",
    category_source: "human",
    description: null,
    description_source: "human",
    lifecycle: "active",
    connector_references: [],
    creator: null,
    checksum: null,
    current_version_id: "version",
    current_version: 1,
    created_at: instant,
    updated_at: instant,
    last_executed_at: null,
    health_state: "healthy",
    health_reason: null,
    health_changed_at: null,
    invalid: false,
    definition,
    steps: definition.steps,
  } as unknown as WorkflowView;
  const detail = serializeWorkflowDetail(workflow, { schedule: null, webhooks_active: 0 });
  expect(WorkflowDetailSchema.parse(detail).definition).toEqual(definition);
});
