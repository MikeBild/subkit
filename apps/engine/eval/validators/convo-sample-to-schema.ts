// Conversation-quality: sampleToSchema produces a schema whose
// `required` list captures every key of a flat object sample. This
// gates the `build_workflow` input_schema_sample inference path.

import { sampleToSchema } from "../../src/workflows/sample-to-schema.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  sample: unknown;
  expect_required: string[];
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as Input;
  const schema = sampleToSchema(input.sample) as {
    type?: string;
    required?: string[];
  };
  if (schema.type !== "object") {
    return { pass: false, reason: `expected type=object, got ${schema.type}` };
  }
  const got = new Set(schema.required ?? []);
  for (const r of input.expect_required) {
    if (!got.has(r)) {
      return { pass: false, reason: `required key '${r}' missing` };
    }
  }
  return { pass: true };
}
