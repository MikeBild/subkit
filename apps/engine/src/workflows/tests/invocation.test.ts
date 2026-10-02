import { describe, expect, test } from "bun:test";
import {
  resolveWorkflowInputSchema,
  sampleFromSchema,
  workflowSampleInput,
} from "../invocation.ts";
import { WorkflowDefSchema } from "../types.ts";

const definition = (extra: Record<string, unknown> = {}) =>
  WorkflowDefSchema.parse({
    name: "invocation",
    steps: [{ kind: "transform", id: "out", expression: "return { ok: true };" }],
    ...extra,
  });

describe("resolveWorkflowInputSchema", () => {
  test("a declared schema wins", () => {
    const schema = { type: "object", properties: { city: { type: "string" } } };
    expect(resolveWorkflowInputSchema(definition({ input_schema: schema }))).toEqual({
      source: "declared",
      schema,
    });
  });

  test("without one, the input the steps read is inferred", () => {
    const resolved = resolveWorkflowInputSchema(
      definition({
        steps: [{ kind: "transform", id: "out", expression: "return { city: input.input.city };" }],
      }),
    );
    expect(resolved.source).toBe("synthesized");
    expect(Object.keys((resolved.schema?.properties ?? {}) as object)).toEqual(["city"]);
  });

  test("a workflow that reads no input has none", () => {
    expect(resolveWorkflowInputSchema(definition())).toEqual({ source: "none", schema: null });
  });
});

describe("sampleFromSchema", () => {
  test("only the required properties, each a placeholder of its type", () => {
    expect(
      sampleFromSchema({
        type: "object",
        properties: {
          name: { type: "string" },
          count: { type: "integer" },
          ratio: { type: "number" },
          enabled: { type: "boolean" },
          tags: { type: "array" },
          optional: { type: "string" },
        },
        required: ["name", "count", "ratio", "enabled", "tags"],
      }),
    ).toEqual({ name: "<name>", count: 0, ratio: 0, enabled: false, tags: [] });
  });

  test("every property when the schema requires none", () => {
    expect(
      sampleFromSchema({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "boolean" } },
      }),
    ).toEqual({ a: "<a>", b: false });
  });

  test("the schema's own example, default, constant or first enum member comes first", () => {
    expect(
      sampleFromSchema({
        type: "object",
        properties: {
          with_examples: { type: "string", examples: ["first", "second"] },
          with_example: { type: "string", example: "one" },
          with_default: { type: "integer", default: 7 },
          with_const: { type: "string", const: "fixed" },
          with_enum: { type: "string", enum: ["low", "high"] },
        },
      }),
    ).toEqual({
      with_examples: "first",
      with_example: "one",
      with_default: 7,
      with_const: "fixed",
      with_enum: "low",
    });
  });

  test("a nested object is filled one level deep", () => {
    expect(
      sampleFromSchema({
        type: "object",
        properties: {
          address: {
            type: "object",
            properties: {
              city: { type: "string" },
              geo: { type: "object", properties: { lat: { type: "number" } } },
            },
          },
        },
      }),
    ).toEqual({ address: { city: "<city>", geo: {} } });
  });

  test("no schema, or one without properties, yields an empty input", () => {
    expect(sampleFromSchema(null)).toEqual({});
    expect(sampleFromSchema({ type: "object" })).toEqual({});
  });
});

describe("workflowSampleInput", () => {
  test("the author's own example payload is used verbatim", () => {
    const sample = { city: "Leipzig", days: 3 };
    const def = definition({ input_schema_sample: sample });
    expect(
      workflowSampleInput(def, { type: "object", properties: { x: { type: "string" } } }),
    ).toEqual(sample);
  });

  test("an example that is not an object falls back to the schema", () => {
    const schema = { type: "object", properties: { x: { type: "string" } } };
    expect(workflowSampleInput(definition({ input_schema_sample: "text" }), schema)).toEqual({
      x: "<x>",
    });
    expect(workflowSampleInput(definition({ input_schema_sample: {} }), schema)).toEqual({
      x: "<x>",
    });
  });
});
