import { describe, expect, it } from "bun:test";
import {
  normalizeSchema,
  readStructuredOutcome,
  structuredOutcomeSchema,
  unwrapResult,
} from "../schema-normalizer.ts";

describe("structuredOutcomeSchema", () => {
  it("roots the outcome in a closed object with ok, nullable value and nullable reason", () => {
    const schema = structuredOutcomeSchema({
      type: "object",
      properties: { a: { type: "string" } },
    });
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["ok", "value", "reason"]);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.ok).toEqual({ type: "boolean" });
    expect(props.reason).toEqual({ type: ["string", "null"] });
    const anyOf = props.value!.anyOf as Array<Record<string, unknown>>;
    expect(anyOf).toHaveLength(2);
    expect(anyOf[0]).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    });
    expect(anyOf[1]).toEqual({ type: "null" });
  });

  it("keeps an array value schema wrapped in result", () => {
    const schema = structuredOutcomeSchema({ type: "array", items: { type: "number" } });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const anyOf = props.value!.anyOf as Array<Record<string, unknown>>;
    expect(anyOf[0]).toMatchObject({
      type: "object",
      required: ["result"],
      properties: { result: { type: "array", items: { type: "number" } } },
    });
  });
});

describe("readStructuredOutcome", () => {
  it("returns the value of an ok outcome", () => {
    expect(readStructuredOutcome({ ok: true, value: { a: 1 }, reason: null }, false)).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("unwraps a result-wrapped array value", () => {
    expect(
      readStructuredOutcome({ ok: true, value: { result: [1, 2] }, reason: null }, true),
    ).toEqual({ ok: true, value: [1, 2] });
  });

  it("treats ok with a null value as empty_value", () => {
    expect(readStructuredOutcome({ ok: true, value: null, reason: null }, false)).toEqual({
      ok: false,
      reason: "empty_value",
    });
  });

  it("returns the reason of a refused outcome and falls back to abort", () => {
    expect(readStructuredOutcome({ ok: false, value: null, reason: "nope" }, false)).toEqual({
      ok: false,
      reason: "nope",
    });
    expect(readStructuredOutcome({ ok: false, value: null, reason: "  " }, false)).toEqual({
      ok: false,
      reason: "abort",
    });
  });

  it("rejects anything that is not an outcome object", () => {
    expect(readStructuredOutcome(undefined, false)).toEqual({
      ok: false,
      reason: "malformed_outcome",
    });
    expect(readStructuredOutcome([1], false)).toEqual({ ok: false, reason: "malformed_outcome" });
  });
});

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

  it("renames oneOf to anyOf and recurses into both", () => {
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
    expect(v).not.toHaveProperty("oneOf");
    const anyOf = v.anyOf as Array<Record<string, unknown>>;
    expect(anyOf[0]).not.toHaveProperty("patternProperties");
    expect(anyOf[0]!.additionalProperties).toBe(false);
    expect(anyOf[1]!.additionalProperties).toBe(false);
  });

  it("backfills empty-object sub-schemas (z.unknown() emits {})", () => {
    const { schema } = normalizeSchema({
      type: "object",
      properties: {
        anything: {},
      },
    });
    const anything = (schema.properties as Record<string, Record<string, unknown>>).anything!;
    expect(anything.type).toBe("string");
  });

  it("backfills shape-less sub-schemas that only carry description", () => {
    const { schema } = normalizeSchema({
      type: "object",
      properties: {
        anything: { description: "free-form" },
      },
    });
    const anything = (schema.properties as Record<string, Record<string, unknown>>).anything!;
    expect(anything.type).toBe("string");
  });

  it("keeps non-shapeless sub-schemas (enum / const / $ref) intact", () => {
    const { schema } = normalizeSchema({
      type: "object",
      properties: {
        choice: { enum: ["a", "b", "c"] },
        literal: { const: "x" },
        ref: { $ref: "#/$defs/Foo" },
      },
    });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.choice).toEqual({ enum: ["a", "b", "c"] });
    expect(props.literal).toEqual({ const: "x" });
    expect(props.ref).toEqual({ $ref: "#/$defs/Foo" });
  });

  it("renames oneOf to anyOf inside arrays' items", () => {
    const { schema } = normalizeSchema({
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            oneOf: [{ type: "string" }, { type: "number" }],
          },
        },
      },
    });
    const rows = (schema.properties as Record<string, Record<string, unknown>>).rows!;
    const items = rows.items as Record<string, unknown>;
    expect(items).not.toHaveProperty("oneOf");
    expect(items.anyOf).toBeDefined();
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
