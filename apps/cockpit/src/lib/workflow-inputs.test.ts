import { describe, expect, test } from "bun:test";
import { buildInput, inputFields, missingRequired } from "./workflow-inputs";

const SCHEMA = {
  type: "object",
  required: ["run_id"],
  properties: {
    run_id: { type: "string", description: "Which run to publish" },
    limit: { type: "number" },
    dry: { type: "boolean" },
    options: { type: "object" },
  },
};

describe("input fields", () => {
  test("reads name, type and requiredness from the schema", () => {
    const fields = inputFields(SCHEMA);
    expect(fields.map((field) => field.name)).toEqual(["run_id", "limit", "dry", "options"]);
    expect(fields[0]).toEqual({
      name: "run_id",
      type: "string",
      required: true,
      description: "Which run to publish",
    });
    expect(fields[1]?.required).toBe(false);
  });

  test("a workflow without inputs offers no form", () => {
    expect(inputFields(null)).toEqual([]);
    expect(inputFields({ type: "object" })).toEqual([]);
  });
});

describe("building the input", () => {
  const fields = inputFields(SCHEMA);

  test("omits empty optional fields instead of sending blanks", () => {
    expect(buildInput(fields, { run_id: "2026-08-10", limit: "", dry: "" })).toEqual({
      run_id: "2026-08-10",
    });
  });

  test("sends numbers and booleans in their own type", () => {
    expect(buildInput(fields, { run_id: "r", limit: "25", dry: "true" })).toEqual({
      run_id: "r",
      limit: 25,
      dry: true,
    });
  });

  test("keeps an unparsable value as text rather than dropping it", () => {
    expect(buildInput(fields, { run_id: "r", limit: "many" })).toEqual({
      run_id: "r",
      limit: "many",
    });
  });

  test("parses structured input", () => {
    expect(buildInput(fields, { run_id: "r", options: '{"deep":true}' })).toEqual({
      run_id: "r",
      options: { deep: true },
    });
  });
});

describe("required fields", () => {
  const fields = inputFields(SCHEMA);

  test("names what is still missing", () => {
    expect(missingRequired(fields, {})).toEqual(["run_id"]);
    expect(missingRequired(fields, { run_id: "  " })).toEqual(["run_id"]);
    expect(missingRequired(fields, { run_id: "r" })).toEqual([]);
  });
});
