import { describe, expect, it } from "bun:test";
import { normalizeSchema, unwrapResult } from "../schema-normalizer.ts";

describe("normalizeSchema", () => {
  it("strips patternProperties", () => {
    const { schema } = normalizeSchema({
      type: "object",
      properties: { name: { type: "string" } },
      patternProperties: { "^x-": { type: "string" } },
    });
    expect(schema).not.toHaveProperty("patternProperties");
  });

  it("forces additionalProperties=false on objects", () => {
    const { schema } = normalizeSchema({
      type: "object",
      properties: { a: { type: "string" } },
    });
    expect(schema.additionalProperties).toBe(false);
  });

  it("forces additionalProperties=false on nested objects", () => {
    const { schema } = normalizeSchema({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { x: { type: "number" } },
        },
      },
    });
    const nested = (schema.properties as Record<string, Record<string, unknown>>).nested!;
    expect(nested.additionalProperties).toBe(false);
  });

  it("wraps array-rooted schemas into { result: [...] }", () => {
    const { schema, wrappedInResult } = normalizeSchema({
      type: "array",
      items: { type: "string" },
    });
    expect(wrappedInResult).toBe(true);
    expect(schema.type).toBe("object");
    expect((schema.properties as { result: unknown }).result).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(schema.required).toEqual(["result"]);
  });

  it("does not wrap object-rooted schemas", () => {
    const { schema, wrappedInResult } = normalizeSchema({
      type: "object",
      properties: { a: { type: "string" } },
    });
    expect(wrappedInResult).toBe(false);
    expect(schema.type).toBe("object");
  });

  it("drops minItems/maxItems on arrays", () => {
    const { schema } = normalizeSchema({
      type: "object",
      properties: {
        xs: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
      },
    });
    const xs = (schema.properties as Record<string, Record<string, unknown>>).xs!;
    expect(xs).not.toHaveProperty("minItems");
    expect(xs).not.toHaveProperty("maxItems");
  });

  it("recurses into oneOf/anyOf/allOf", () => {
    const { schema } = normalizeSchema({
      type: "object",
      properties: {
        v: {
          oneOf: [
            { type: "object", properties: { kind: { const: "a" } }, patternProperties: {} },
            { type: "object", properties: { kind: { const: "b" } } },
          ],
        },
      },
    });
    const v = (schema.properties as Record<string, Record<string, unknown>>).v!;
    const oneOf = v.oneOf as Array<Record<string, unknown>>;
    expect(oneOf[0]).not.toHaveProperty("patternProperties");
    expect(oneOf[0]!.additionalProperties).toBe(false);
    expect(oneOf[1]!.additionalProperties).toBe(false);
  });
});

describe("unwrapResult", () => {
  it("unwraps when wrappedInResult is true", () => {
    const out = unwrapResult<string[]>({ result: ["a", "b"] }, true);
    expect(out).toEqual(["a", "b"]);
  });

  it("passes through when not wrapped", () => {
    const out = unwrapResult<{ x: number }>({ x: 1 }, false);
    expect(out).toEqual({ x: 1 });
  });

  it("passes through when wrapped but value lacks result", () => {
    const out = unwrapResult<{ x: number }>({ x: 1 }, true);
    expect(out).toEqual({ x: 1 });
  });
});
