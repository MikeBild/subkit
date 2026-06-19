// sampleToSchema inference tests.

import { describe, expect, test } from "bun:test";
import { sampleToSchema } from "../sample-to-schema.ts";

describe("sampleToSchema — primitives", () => {
  test("null and undefined → empty schema", () => {
    expect(sampleToSchema(null)).toEqual({});
    expect(sampleToSchema(undefined)).toEqual({});
  });

  test("string / number / boolean / bigint", () => {
    expect(sampleToSchema("x")).toEqual({ type: "string" });
    expect(sampleToSchema(42)).toEqual({ type: "number" });
    expect(sampleToSchema(true)).toEqual({ type: "boolean" });
    expect(sampleToSchema(BigInt(1))).toEqual({ type: "integer" });
  });
});

describe("sampleToSchema — arrays", () => {
  test("empty array → items: {}", () => {
    expect(sampleToSchema([])).toEqual({ type: "array", items: {} });
  });

  test("homogeneous primitive array → items with type", () => {
    expect(sampleToSchema([1, 2, 3])).toEqual({
      type: "array",
      items: { type: "number" },
    });
  });

  test("homogeneous object array → items with properties + required", () => {
    const s = sampleToSchema([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    expect(s).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, n: { type: "number" } },
        required: ["id", "n"],
      },
    });
  });

  test("mixed primitive array produces oneOf", () => {
    const s = sampleToSchema([1, "x", true]);
    expect(s).toHaveProperty("type", "array");
    const items = (s as { items: { oneOf: unknown[] } }).items;
    expect(Array.isArray(items.oneOf)).toBe(true);
    expect(items.oneOf).toHaveLength(3);
  });

  test("mixed-shape object array unions properties, drops mismatched required", () => {
    const s = sampleToSchema([{ id: "a", extra: "only-in-first" }, { id: "b" }]);
    const items = (s as { items: JsonLike }).items;
    expect(items.type).toBe("object");
    const props = (items.properties ?? {}) as Record<string, JsonLike>;
    expect(props.id).toEqual({ type: "string" });
    expect(props.extra).toEqual({ type: "string" });
    expect(items.required).toEqual(["id"]); // extra was not in both → not required
  });
});

describe("sampleToSchema — objects", () => {
  test("flat object → object with properties + required all keys", () => {
    expect(sampleToSchema({ a: 1, b: "x" })).toEqual({
      type: "object",
      properties: { a: { type: "number" }, b: { type: "string" } },
      required: ["a", "b"],
    });
  });

  test("empty object → just { type: object }", () => {
    expect(sampleToSchema({})).toEqual({ type: "object" });
  });

  test("nested object preserves nesting", () => {
    const s = sampleToSchema({
      user: { id: 1, email: "a@b.c" },
      active: true,
    });
    const prop = (s as { properties: Record<string, JsonLike> }).properties;
    expect(prop.user).toEqual({
      type: "object",
      properties: { id: { type: "number" }, email: { type: "string" } },
      required: ["id", "email"],
    });
    expect(prop.active).toEqual({ type: "boolean" });
  });

  test("object with array-of-objects maintains union inside items", () => {
    const s = sampleToSchema({
      rows: [
        { id: "a", tag: 1 },
        { id: "b", tag: "x" },
      ],
    });
    const prop = (s as { properties: { rows: JsonLike } }).properties.rows;
    expect(prop.type).toBe("array");
    const items = (prop.items ?? {}) as JsonLike;
    expect(items.type).toBe("object");
    const tag = ((items.properties ?? {}) as Record<string, JsonLike>).tag;
    expect(tag).toBeTruthy();
    expect((tag as { oneOf: unknown[] }).oneOf).toHaveLength(2);
  });
});

describe("sampleToSchema — determinism", () => {
  test("same input produces the same schema bytes twice", () => {
    const input = { a: [1, 2], b: { c: "x" } };
    expect(JSON.stringify(sampleToSchema(input))).toBe(JSON.stringify(sampleToSchema(input)));
  });

  test("equivalent-object arrays dedup to a single items schema", () => {
    const a = sampleToSchema([{ x: 1 }, { x: 2 }]);
    const b = sampleToSchema([{ x: 1 }]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

type JsonLike = Record<string, unknown>;
