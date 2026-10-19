import { describe, expect, test } from "bun:test";
import { jsonSchema, tool } from "ai";
import { z } from "zod";
import { compatibleToolPalette, supportsToolSchema } from "./tool-schema-compatibility.ts";

describe("provider palettes use compatible object schemas", () => {
  test("preserves nested discriminated input contracts", () => {
    expect(
      supportsToolSchema({
        type: "object",
        properties: { action: { oneOf: [{ type: "string" }, { type: "number" }] } },
      }),
    ).toBe(true);
  });
  test.each(["oneOf", "allOf", "anyOf", "$ref"])(
    "omits root %s without weakening the workflow",
    (key) => {
      const schema = { type: "object", [key]: [{ required: ["action"] }] };
      const before = JSON.stringify(schema);
      expect(supportsToolSchema(schema)).toBe(false);
      expect(JSON.stringify(schema)).toBe(before);
    },
  );
  test("refuses non-object input", () => {
    expect(supportsToolSchema({ type: "array" })).toBe(false);
  });
});

test("filters incompatible tools from any source and keeps original runnable tools", async () => {
  const valid = tool({ inputSchema: z.object({ action: z.string() }) });
  const invalid = tool({
    inputSchema: jsonSchema({ type: "object", oneOf: [{ required: ["a"] }, { required: ["b"] }] }),
  });
  const result = await compatibleToolPalette({
    native: valid,
    external: invalid,
    workflow: invalid,
  });
  expect(result.tools).toEqual({ native: valid });
  expect(result.omitted).toEqual(["external", "workflow"]);
});
