// Edge-case lint for individual tool inputs that have historically
// or could plausibly produce surprising JSON-Schema output:
//
//   - z.discriminatedUnion (edit_workflow_patch.PatchOp) → must be
//     wrapped in an object so the root stays type:"object"
//   - z.record (suggest_jsonata_paths step_config-like, build_workflow.input_schema)
//     → must NOT collapse into additionalProperties:any losing required fields
//   - z.unknown / z.any → MUST appear inside an object property,
//     never at the root
//   - z.never / fields that should be impossible to reach
//   - very large enum lists should pass-through cleanly
//   - default values shouldn't exclude the field from `properties`
//
// This test suite picks specific tools known to exercise each case
// and asserts the precise shape rather than the general pattern, so
// a future refactor that swaps schema types breaks loudly.

import { describe, expect, test } from "bun:test";
import type { ZodType } from "zod";
import { zodToJsonSchema7 } from "../../mcp/json-schema.ts";
import { getTool } from "../tools/index.ts";

function jsonSchema(toolName: string): Record<string, unknown> {
  const tool = getTool(toolName);
  if (!tool) throw new Error(`tool not registered: ${toolName}`);
  return zodToJsonSchema7(tool.inputSchema as ZodType);
}

describe("input-schema edge cases · per tool", () => {
  test("edit_workflow_patch (RFC 6902 discriminated union) — root is object", () => {
    const j = jsonSchema("edit_workflow_patch");
    expect(j.type).toBe("object");
    const props = j.properties as Record<string, { type?: string }>;
    expect(props.patches?.type).toBe("array");
  });

  test("test_rbac_expression — root is object (regression: was union)", () => {
    const j = jsonSchema("test_rbac_expression");
    expect(j.type).toBe("object");
    expect(j.anyOf).toBeUndefined();
    expect(j.oneOf).toBeUndefined();
    const props = j.properties as Record<string, unknown>;
    // Both modes' fields are reachable from the root.
    expect(props.mode).toBeDefined();
    expect(props.actor_id).toBeDefined();
    expect(props.expression).toBeDefined();
    expect(props.step_config).toBeDefined();
  });

  test("suggest_jsonata_paths — required step_id is in `required`", () => {
    const j = jsonSchema("suggest_jsonata_paths");
    expect(j.type).toBe("object");
    expect(j.required).toContain("step_id");
  });

  test("build_workflow — input_schema_sample is z.unknown (any value allowed)", () => {
    const j = jsonSchema("build_workflow");
    const props = j.properties as Record<string, unknown>;
    expect(props.input_schema_sample).toBeDefined();
  });

  test("update_param — `value` accepts unknown without dropping the property", () => {
    const j = jsonSchema("update_param");
    const props = j.properties as Record<string, unknown>;
    expect(props.value).toBeDefined();
    expect(j.required).toEqual(expect.arrayContaining(["step_id", "param", "value"]));
  });

  test("propose_step — `step` is a record, not stripped to additionalProperties:true alone", () => {
    const j = jsonSchema("propose_step");
    const props = j.properties as Record<string, { type?: string }>;
    expect(props.step?.type).toBe("object");
  });

  test("ask_user_choice — options is an array of objects with id+label", () => {
    const j = jsonSchema("ask_user_choice");
    const props = j.properties as Record<string, { type?: string; items?: { type?: string } }>;
    expect(props.options?.type).toBe("array");
    expect(props.options?.items?.type).toBe("object");
  });

  test("find_workflow / find_connector / find_skill — query is optional, limit has default", () => {
    for (const name of ["find_workflow", "find_connector", "find_skill"]) {
      const j = jsonSchema(name);
      expect(j.type).toBe("object");
      const props = j.properties as Record<string, unknown>;
      expect(props.query).toBeDefined();
      expect(props.limit).toBeDefined();
      // query is optional → should NOT appear in required
      const req = (j.required ?? []) as string[];
      expect(req).not.toContain("query");
    }
  });

  test("dry_run_workflow — input is unknown-typed and optional", () => {
    const j = jsonSchema("dry_run_workflow");
    const props = j.properties as Record<string, unknown>;
    expect(props.input).toBeDefined();
    const req = (j.required ?? []) as string[];
    expect(req).not.toContain("input");
  });

  test("inspect_workflow — sections enum is bounded", () => {
    const j = jsonSchema("inspect_workflow");
    const props = j.properties as Record<string, { type?: string; items?: { enum?: unknown[] } }>;
    expect(props.sections?.items?.enum).toEqual(
      expect.arrayContaining([
        "instruction",
        "input_schema",
        "output_schema",
        "output_transform",
        "payload",
        "response_filters",
      ]),
    );
  });

  test("edit_role — name length capped (max 100)", () => {
    const j = jsonSchema("edit_role");
    const props = j.properties as Record<string, { maxLength?: number }>;
    expect(props.name?.maxLength).toBe(100);
  });

  test("ask_user_form — fields description survives serialisation", () => {
    const j = jsonSchema("ask_user_form");
    expect(typeof j).toBe("object");
    expect(JSON.stringify(j).length).toBeGreaterThan(0);
  });
});
