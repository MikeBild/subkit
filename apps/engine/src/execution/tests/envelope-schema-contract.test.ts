import { describe, expect, test } from "bun:test";
import { validateAgainstJsonSchema } from "../engine/envelope.ts";

const schema = {
  type: "object",
  required: ["context"],
  additionalProperties: false,
  properties: {
    context: {
      type: "object",
      required: ["requestId", "metadata"],
      additionalProperties: false,
      properties: {
        requestId: { type: "string", minLength: 2, maxLength: 8 },
        metadata: {
          type: "object",
          required: ["count", "labels"],
          additionalProperties: false,
          properties: {
            count: { type: "integer", minimum: 0, maximum: 8 },
            note: { type: "string", maxLength: 8 },
            labels: {
              type: "array",
              minItems: 1,
              maxItems: 2,
              uniqueItems: true,
              items: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
  },
};
const context = { requestId: "req", metadata: { count: 8, labels: ["音楽", "👋"] } };
const invalidCases: Array<[string, unknown]> = [
  ["null root", null],
  ["array root", []],
  ["scalar root", "context"],
  ["unknown root field", { context, authority: "forged" }],
  [
    "missing nested required field",
    { context: { requestId: "req", metadata: { labels: ["one"] } } },
  ],
  [
    "unknown nested metadata field",
    { context: { ...context, metadata: { ...context.metadata, unexpected: true } } },
  ],
  ["short nested string", { context: { ...context, requestId: "r" } }],
  ["long nested string", { context: { ...context, requestId: "x".repeat(9) } }],
  ["nested string type", { context: { ...context, requestId: 42 } }],
  [
    "fractional nested integer",
    { context: { ...context, metadata: { ...context.metadata, count: 0.5 } } },
  ],
  [
    "integer below minimum",
    { context: { ...context, metadata: { ...context.metadata, count: -1 } } },
  ],
  [
    "integer above maximum",
    { context: { ...context, metadata: { ...context.metadata, count: 9 } } },
  ],
  [
    "empty nested array",
    { context: { ...context, metadata: { ...context.metadata, labels: [] } } },
  ],
  [
    "oversized nested array",
    { context: { ...context, metadata: { ...context.metadata, labels: ["a", "b", "c"] } } },
  ],
  [
    "wrong array item type",
    { context: { ...context, metadata: { ...context.metadata, labels: [4] } } },
  ],
  [
    "empty array item",
    { context: { ...context, metadata: { ...context.metadata, labels: [""] } } },
  ],
  [
    "duplicate array items",
    { context: { ...context, metadata: { ...context.metadata, labels: ["a", "a"] } } },
  ],
];

describe("runtime JSON Schema envelope contract", () => {
  test("accepts valid nested Unicode data without mutation", () => {
    const input = { context: structuredClone(context) };
    const before = structuredClone(input);
    expect(validateAgainstJsonSchema(input, schema, "$input")).toEqual({ valid: true, errors: [] });
    expect(input).toEqual(before);
  });

  for (const [name, input] of invalidCases) {
    test(`rejects ${name}`, () => {
      const before = structuredClone(input);
      const result = validateAgainstJsonSchema(input, schema, "$input");
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.join(" ")).toContain("$input");
      expect(input).toEqual(before);
    });
  }

  test("does not coerce values, insert defaults, or remove unknown properties", () => {
    const input = { count: "2", unexpected: true };
    const before = structuredClone(input);
    const contract = {
      type: "object",
      required: ["count", "label"],
      additionalProperties: false,
      properties: { count: { type: "integer" }, label: { type: "string", default: "inserted" } },
    };
    expect(validateAgainstJsonSchema(input, contract, "$input").valid).toBe(false);
    expect(input).toEqual(before);
  });

  test("resolves local references and enforces their nested constraints", () => {
    const contract = {
      type: "object",
      required: ["context"],
      properties: { context: { $ref: "#/$defs/context" } },
      $defs: { context: schema.properties.context },
    };
    expect(validateAgainstJsonSchema({ context }, contract, "$input").valid).toBe(true);
    expect(
      validateAgainstJsonSchema(
        { context: { ...context, requestId: "x".repeat(9) } },
        contract,
        "$input",
      ).valid,
    ).toBe(false);
  });

  for (const [name, contract] of [
    ["invalid keyword type", { type: 123 }],
    ["unresolved external reference", { $ref: "https://schema.example/unknown" }],
    ["asynchronous schema", { $async: true, type: "object" }],
  ] as const) {
    test(`fails closed for ${name}`, () => {
      const result = validateAgainstJsonSchema({}, contract, "$input");
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  }

  test("reports the field path without revealing the rejected value", () => {
    const sensitive = "private-value-must-not-be-rendered";
    const result = validateAgainstJsonSchema(
      { context: { ...context, metadata: { ...context.metadata, count: sensitive } } },
      schema,
      "$input",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("$input");
    expect(result.errors.join(" ")).not.toContain(sensitive);
  });
});
