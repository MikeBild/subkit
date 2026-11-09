import { expect, test } from "bun:test";
import { validateOutputSchemaSuperset as coreGate } from "./core/output-schema-gate.ts";
import { validateOutputSchemaSuperset as publicGate } from "./validator.ts";

test("the existing validator export preserves the output-schema gate contract", () => {
  expect(publicGate).toBe(coreGate);
  expect(publicGate({ required: ["report"] }, { properties: { report: {} } })).toEqual({
    ok: true,
    missing_fields: [],
  });
});
