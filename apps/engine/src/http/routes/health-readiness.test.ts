import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { HealthResponse, ReadyResponse } from "./health.ts";
import schema from "./health-readiness.schema.json" with { type: "json" };

type JsonSchema = {
  type?: string;
  const?: string;
  enum?: string[];
  $ref?: string;
  required?: string[];
  additionalProperties?: unknown;
  properties?: Record<string, JsonSchema>;
};

const resolve = (node: JsonSchema | undefined): JsonSchema | undefined =>
  node?.$ref
    ? (schema.$defs[node.$ref.replace("#/$defs/", "") as keyof typeof schema.$defs] as JsonSchema)
    : node;

const values = (node: JsonSchema | undefined): string[] => {
  const target = resolve(node);
  return target?.const !== undefined ? [target.const] : [...(target?.enum ?? [])].sort();
};

function expectSameShape(engine: JsonSchema, document: JsonSchema): void {
  expect(engine.additionalProperties).toBe(false);
  expect(document.additionalProperties).toBe(false);
  expect([...(engine.required ?? [])].sort()).toEqual([...(document.required ?? [])].sort());
  expect(Object.keys(engine.properties ?? {}).sort()).toEqual(
    Object.keys(document.properties ?? {}).sort(),
  );
  for (const [name, property] of Object.entries(document.properties ?? {})) {
    const target = resolve(property);
    if (target?.type === "object") expectSameShape(engine.properties?.[name] ?? {}, target);
    else if (values(property).length > 0)
      expect(values(engine.properties?.[name])).toEqual(values(property));
  }
}

describe("health and readiness schema", () => {
  test("the liveness response matches the health document", () => {
    expectSameShape(
      z.toJSONSchema(HealthResponse) as JsonSchema,
      schema.$defs.health as JsonSchema,
    );
  });

  test("the readiness response matches the ready document", () => {
    expectSameShape(z.toJSONSchema(ReadyResponse) as JsonSchema, schema.$defs.ready as JsonSchema);
  });
});
