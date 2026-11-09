import { expect, test } from "bun:test";
import fc from "fast-check";
import { validateOutputSchemaSuperset } from "./output-schema-gate.ts";

test("only required string fields constrain a workflow output", () => {
  expect(validateOutputSchemaSuperset(null, null)).toEqual({ ok: true, missing_fields: [] });
  expect(validateOutputSchemaSuperset({}, null)).toEqual({ ok: true, missing_fields: [] });
  expect(validateOutputSchemaSuperset({ required: "name" }, null)).toEqual({
    ok: true,
    missing_fields: [],
  });
  expect(validateOutputSchemaSuperset({ required: [1, null, "name"] }, null)).toEqual({
    ok: false,
    missing_fields: ["name"],
  });
  expect(validateOutputSchemaSuperset({ required: ["name"] }, { properties: "name" })).toEqual({
    ok: false,
    missing_fields: ["name"],
  });
});

test("rejects callable schemas and malformed property containers without inspecting them", () => {
  const callableSkill = Object.assign(() => undefined, { required: ["name"] });
  const callableWorkflow = Object.assign(() => undefined, { properties: { name: {} } });

  expect(validateOutputSchemaSuperset(callableSkill as never, null)).toEqual({
    ok: true,
    missing_fields: [],
  });
  expect(validateOutputSchemaSuperset({ required: ["name"] }, callableWorkflow as never)).toEqual({
    ok: false,
    missing_fields: ["name"],
  });
  expect(validateOutputSchemaSuperset({ required: ["name"] }, { properties: null })).toEqual({
    ok: false,
    missing_fields: ["name"],
  });
  expect(validateOutputSchemaSuperset({ required: ["0"] }, { properties: "x" })).toEqual({
    ok: false,
    missing_fields: ["0"],
  });
});

test("does not inspect a workflow schema when the skill requires no output fields", () => {
  const workflow = Object.defineProperty({}, "properties", {
    get() {
      throw new Error("workflow properties must stay lazy when requirements are empty");
    },
  });
  expect(validateOutputSchemaSuperset({ required: [] }, workflow)).toEqual({
    ok: true,
    missing_fields: [],
  });
});

test("reports missing fields in declared order and preserves both input schemas", () => {
  fc.assert(
    fc.property(fc.array(fc.string()), fc.array(fc.string()), (required, provided) => {
      const properties = Object.freeze(Object.fromEntries(provided.map((field) => [field, {}])));
      const skill = Object.freeze({ required: Object.freeze([...required]) });
      const workflow = Object.freeze({ properties });
      const missing = required.filter((field) => !Object.hasOwn(properties, field));
      expect(validateOutputSchemaSuperset(skill, workflow)).toEqual({
        ok: missing.length === 0,
        missing_fields: missing,
      });
      expect(skill.required).toEqual(required);
      expect(Object.keys(properties).sort()).toEqual([...new Set(provided)].sort());
    }),
    { seed: 20261109, numRuns: 100 },
  );
});
