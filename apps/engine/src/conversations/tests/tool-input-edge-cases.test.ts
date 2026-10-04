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

  test("author_workflow — input_example is z.unknown (any value allowed)", () => {
    const j = jsonSchema("author_workflow");
    const props = j.properties as Record<string, unknown>;
    expect(props.input_example).toBeDefined();
    expect(j.required).toContain("goal");
  });

  test("edit_workflow_patch — positional and stable-ID arrays are exclusive alternatives", () => {
    const j = jsonSchema("edit_workflow_patch");
    const props = j.properties as Record<string, { type?: string }>;
    expect(props.patches?.type).toBe("array");
    expect(props.step_patches?.type).toBe("array");
    const schema = getTool("edit_workflow_patch")!.inputSchema;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ patches: [], step_patches: [] }).success).toBe(false);
    expect(
      schema.safeParse({ patches: [{ op: "replace", path: "/name", value: "Report" }] }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        step_patches: [
          {
            op: "add",
            step_id: "store",
            path: "/s3/scope",
            value: { key_prefix: "reports/", max_bytes: 1000 },
          },
        ],
      }).success,
    ).toBe(true);
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
