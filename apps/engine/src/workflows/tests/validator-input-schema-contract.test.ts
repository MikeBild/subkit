import { expect, test } from "bun:test";
import { validateWorkflowDef } from "../validator.ts";

const definition = {
  name: "Nested input contract",
  steps: [{ id: "out", kind: "transform", expression: "return {};" }],
};

for (const [name, input_schema] of [
  ["invalid nested keyword", { type: "object", properties: { context: { type: 123 } } }],
  ["unresolved external reference", { $ref: "https://schema.example/unknown" }],
  ["asynchronous schema", { $async: true, type: "object" }],
] as const) {
  test(`authoring refuses ${name} before execution`, () => {
    const result = validateWorkflowDef({ ...definition, input_schema });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path === "input_schema")).toBe(true);
  });
}

test("authoring accepts nested constraints and local references", () => {
  const result = validateWorkflowDef({
    ...definition,
    input_schema: {
      type: "object",
      properties: { context: { $ref: "#/$defs/context" } },
      $defs: {
        context: {
          type: "object",
          additionalProperties: false,
          required: ["requestId"],
          properties: { requestId: { type: "string", minLength: 1, maxLength: 64 } },
        },
      },
    },
  });
  expect(result.ok).toBe(true);
  expect(result.errors).toEqual([]);
});
