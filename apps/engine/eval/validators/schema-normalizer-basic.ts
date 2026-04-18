import { normalizeSchema } from "../../src/llm/core/schema-normalizer.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as { schema: Record<string, unknown> };
  const { schema, wrappedInResult } = normalizeSchema(input.schema);
  if (!wrappedInResult) return { pass: false, reason: "expected array root to be wrapped" };
  if (schema.type !== "object") return { pass: false, reason: `root type is ${schema.type}` };
  // patternProperties must be stripped inside items.
  const wrapped = schema.properties as Record<string, Record<string, unknown>>;
  const items = (wrapped.result as { items: Record<string, unknown> }).items;
  if ("patternProperties" in items) {
    return { pass: false, reason: "patternProperties leaked into normalised schema" };
  }
  return { pass: true };
}
