import { describe, expect, test } from "bun:test";
import { validateWorkflowDef } from "../core/validator.ts";
import { WorkflowDefSchema } from "../types.ts";

const BASE = {
  name: "contract",
  steps: [
    {
      kind: "transform",
      id: "shape",
      language: "javascript",
      expression: "return { total: 1, items: [] };",
    },
  ],
};

describe("WorkflowDefSchema · output_schema", () => {
  test("round-trips an output_schema in the definition JSON", () => {
    const schema = {
      type: "object",
      properties: { total: { type: "number" } },
      required: ["total"],
    };
    const parsed = WorkflowDefSchema.parse({ ...BASE, output_schema: schema });
    expect(parsed.output_schema).toEqual(schema);
  });

  test("output_schema stays optional", () => {
    const parsed = WorkflowDefSchema.parse(BASE);
    expect(parsed.output_schema).toBeUndefined();
  });

  test("non-object output_schema is refused at the zod layer", () => {
    const result = WorkflowDefSchema.safeParse({ ...BASE, output_schema: "not-a-schema" });
    expect(result.success).toBe(false);
  });
});

describe("validateWorkflowDef · output_schema sanity", () => {
  test("accepts a definition with a compilable object schema", () => {
    const verdict = validateWorkflowDef({
      ...BASE,
      output_schema: {
        type: "object",
        properties: { total: { type: "number" }, items: { type: "array" } },
        required: ["total", "items"],
      },
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.errors).toEqual([]);
  });

  test("refuses an output_schema Ajv cannot compile, with the field path", () => {
    const verdict = validateWorkflowDef({
      ...BASE,
      output_schema: { type: 123 },
    });
    expect(verdict.ok).toBe(false);
    const err = verdict.errors.find((e) => e.path === "output_schema");
    expect(err).toBeDefined();
    expect(err?.message).toContain("not a valid JSON Schema");
  });
});
