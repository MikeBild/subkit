// Skill-schema gate — pure unit tests for the structural superset check.
//
// The DB-backed wrapper that loads the skill row lives in
// apps/engine/src/workflows/service.ts and is exercised in the
// integration suite. This file pins just the shape comparison.

import { describe, expect, test } from "bun:test";
import { validateOutputSchemaSuperset } from "./validator.ts";

describe("validateOutputSchemaSuperset", () => {
  test("null skill schema → always ok (no contract to enforce)", () => {
    const r = validateOutputSchemaSuperset(null, { type: "object" });
    expect(r.ok).toBe(true);
    expect(r.missing_fields).toEqual([]);
  });

  test("skill with no required fields → always ok", () => {
    const r = validateOutputSchemaSuperset(
      { type: "object", properties: { x: { type: "string" } } },
      { type: "object" },
    );
    expect(r.ok).toBe(true);
  });

  test("workflow output_schema covers every required field → ok", () => {
    const r = validateOutputSchemaSuperset(
      { type: "object", required: ["id", "email"], properties: {} },
      {
        type: "object",
        properties: {
          id: { type: "string" },
          email: { type: "string" },
          extra: { type: "string" },
        },
      },
    );
    expect(r.ok).toBe(true);
  });

  test("workflow missing one required field → fails with that field listed", () => {
    const r = validateOutputSchemaSuperset(
      { type: "object", required: ["id", "email"], properties: {} },
      { type: "object", properties: { id: { type: "string" } } },
    );
    expect(r.ok).toBe(false);
    expect(r.missing_fields).toEqual(["email"]);
  });

  test("workflow with no properties + skill requires fields → all missing", () => {
    const r = validateOutputSchemaSuperset(
      { type: "object", required: ["a", "b", "c"], properties: {} },
      null,
    );
    expect(r.ok).toBe(false);
    expect(r.missing_fields).toEqual(["a", "b", "c"]);
  });
});
