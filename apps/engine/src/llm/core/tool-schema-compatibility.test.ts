import { describe, expect, test } from "bun:test";
import { asSchema, jsonSchema, tool } from "ai";
import { z } from "zod";
import {
  compactToolJsonSchema,
  compatibleToolPalette,
  supportsToolSchema,
} from "./tool-schema-compatibility.ts";

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
  const execute = async () => ({ ok: true });
  const valid = tool({ inputSchema: z.object({ action: z.string() }), execute });
  const invalid = tool({
    inputSchema: jsonSchema({ type: "object", oneOf: [{ required: ["a"] }, { required: ["b"] }] }),
  });
  const result = await compatibleToolPalette({
    native: valid,
    external: invalid,
    workflow: invalid,
  });
  expect(Object.keys(result.tools)).toEqual(["native"]);
  expect(result.tools.native?.execute).toBe(execute);
  expect(result.omitted).toEqual(["external", "workflow"]);
});

test("sends compact schemas while keeping the original validation", async () => {
  const input = z.object({
    id: z.string().uuid(),
    since: z.string().datetime(),
    limit: z.number().int().optional(),
    slug: z.string().regex(/^[a-z]+$/),
  });
  const result = await compatibleToolPalette({ native: tool({ inputSchema: input }) });
  const sent = asSchema(result.tools.native?.inputSchema);
  const schema = (await sent.jsonSchema) as {
    $schema?: string;
    properties: Record<string, Record<string, unknown>>;
  };
  expect(schema.$schema).toBeUndefined();
  expect(schema.properties.id).toMatchObject({ type: "string", format: "uuid" });
  expect(schema.properties.id?.pattern).toBeUndefined();
  expect(schema.properties.since).toMatchObject({ format: "date-time" });
  expect(schema.properties.since?.pattern).toBeUndefined();
  expect(schema.properties.limit?.maximum).toBeUndefined();
  expect(schema.properties.slug?.pattern).toBe("^[a-z]+$");
  const accepted = await sent.validate?.({
    id: "00000000-0000-4000-8000-000000000001",
    since: "2026-10-28T10:00:00Z",
    slug: "abc",
  });
  expect(accepted?.success).toBe(true);
  const rejected = await sent.validate?.({ id: "not-a-uuid", since: "yesterday", slug: "ABC" });
  expect(rejected?.success).toBe(false);
});

test("compaction leaves bounded integers and custom patterns untouched", () => {
  expect(compactToolJsonSchema({ type: "integer", minimum: 1, maximum: 100 })).toEqual({
    type: "integer",
    minimum: 1,
    maximum: 100,
  });
  expect(compactToolJsonSchema({ type: "string", pattern: "^x$" })).toEqual({
    type: "string",
    pattern: "^x$",
  });
});
