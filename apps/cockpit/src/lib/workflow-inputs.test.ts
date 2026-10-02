import { describe, expect, test } from "bun:test";
import {
  buildFormInput,
  buildInput,
  flattenInputFields,
  formFields,
  initialInputValues,
  inputControl,
  inputFields,
  inputForm,
  inputItemTypeKey,
  inputSampleText,
  inputTypeKey,
  invalidInputs,
  missingRequired,
} from "./workflow-inputs";

const SCHEMA = {
  type: "object",
  required: ["run_id", "mode"],
  properties: {
    run_id: { type: "string", description: "Which run to publish" },
    limit: { type: "number", default: 25 },
    pages: { type: "integer" },
    dry: { type: "boolean" },
    mode: { type: "string", enum: ["draft", "live"], examples: ["live"] },
    recipient: { type: "string", format: "email", example: "ops@example.org" },
    tags: { type: "array", items: { type: "string" } },
    options: {
      type: "object",
      required: ["depth"],
      properties: {
        depth: { type: "integer", default: 2 },
        nested: { type: "object", properties: { deeper: { type: "string" } } },
      },
    },
  },
};

const field = (name: string) => {
  const found = inputFields(SCHEMA).find((entry) => entry.name === name);
  if (!found) throw new Error(`no field ${name}`);
  return found;
};

describe("input fields", () => {
  test("reads name, type, requiredness and description from the schema", () => {
    const fields = inputFields(SCHEMA);
    expect(fields.map((entry) => entry.name)).toEqual([
      "run_id",
      "limit",
      "pages",
      "dry",
      "mode",
      "recipient",
      "tags",
      "options",
    ]);
    expect(fields[0]).toEqual({
      name: "run_id",
      path: "run_id",
      type: "string",
      union: null,
      format: null,
      itemType: null,
      required: true,
      description: "Which run to publish",
      options: null,
      defaultValue: undefined,
      example: undefined,
      children: [],
    });
    expect(field("limit").required).toBe(false);
  });

  test("carries the allowed values, the default and the example", () => {
    expect(field("mode").options).toEqual(["draft", "live"]);
    expect(field("mode").example).toBe("live");
    expect(field("limit").defaultValue).toBe(25);
    expect(field("recipient").format).toBe("email");
    expect(field("recipient").example).toBe("ops@example.org");
  });

  test("names the element type of a list", () => {
    expect(field("tags").type).toBe("array");
    expect(field("tags").itemType).toBe("string");
    expect(inputItemTypeKey(field("tags"))).toBe("input.type.string");
    expect(inputItemTypeKey(field("run_id"))).toBeNull();
  });

  test("reads an object's own fields one level deep, and no deeper", () => {
    const options = field("options");
    expect(options.children.map((child) => [child.name, child.path, child.required])).toEqual([
      ["depth", "options.depth", true],
      ["nested", "options.nested", false],
    ]);
    // The second level is one JSON value, not a further table.
    expect(options.children[1]?.children).toEqual([]);
  });

  test("lays an object's fields out as rows under it", () => {
    expect(flattenInputFields(inputFields(SCHEMA)).map((entry) => entry.path)).toEqual([
      "run_id",
      "limit",
      "pages",
      "dry",
      "mode",
      "recipient",
      "tags",
      "options",
      "options.depth",
      "options.nested",
    ]);
  });

  test("a property without a type reads as text; a nullable one as its real type", () => {
    const fields = inputFields({
      properties: {
        bare: {},
        nullable: { type: ["null", "integer"] },
        shaped: { properties: { a: {} } },
        listed: { items: {} },
      },
    });
    expect(fields.map((entry) => entry.type)).toEqual(["string", "integer", "object", "array"]);
  });

  test("a workflow without inputs offers no form", () => {
    expect(inputFields(null)).toEqual([]);
    expect(inputFields({ type: "object" })).toEqual([]);
  });
});

describe("what a field is called and shown as", () => {
  test("a type has a word; a text field with a known format names that", () => {
    expect(inputTypeKey(field("run_id"))).toBe("input.type.string");
    expect(inputTypeKey(field("pages"))).toBe("input.type.integer");
    expect(inputTypeKey(field("dry"))).toBe("input.type.boolean");
    expect(inputTypeKey(field("recipient"))).toBe("input.type.email");
    expect(inputTypeKey({ type: "file", format: null })).toBe("input.type.file");
    expect(inputTypeKey({ type: "future", format: null })).toBe("input.type.string");
  });

  test("the example leads, the default follows, and nothing is invented", () => {
    expect(inputSampleText(field("mode"))).toBe("live");
    expect(inputSampleText(field("limit"))).toBe("25");
    expect(inputSampleText(field("run_id"))).toBeNull();
    expect(inputSampleText({ example: undefined, defaultValue: { a: 1 } })).toBe('{"a":1}');
  });

  test("each type is filled in with its own control", () => {
    expect(inputControl(field("run_id"))).toBe("text");
    expect(inputControl(field("limit"))).toBe("number");
    expect(inputControl(field("pages"))).toBe("number");
    expect(inputControl(field("dry"))).toBe("boolean");
    expect(inputControl(field("mode"))).toBe("select");
    expect(inputControl(field("tags"))).toBe("json");
    expect(inputControl(field("options"))).toBe("json");
  });
});

describe("building the input", () => {
  const fields = inputFields(SCHEMA);

  test("the form starts with the schema's defaults", () => {
    expect(initialInputValues(fields)).toEqual({ limit: "25" });
  });

  test("omits empty optional fields instead of sending blanks", () => {
    expect(buildInput(fields, { run_id: "2030-08-10", limit: "", dry: "" })).toEqual({
      run_id: "2030-08-10",
    });
  });

  test("sends numbers, booleans and enum members in their own type", () => {
    expect(
      buildInput(fields, { run_id: "r", limit: "25", pages: "3", dry: "true", mode: "live" }),
    ).toEqual({ run_id: "r", limit: 25, pages: 3, dry: true, mode: "live" });
    const numeric = inputFields({ properties: { level: { type: "integer", enum: [1, 2] } } });
    expect(buildInput(numeric, { level: "2" })).toEqual({ level: 2 });
  });

  test("parses structured input", () => {
    expect(buildInput(fields, { run_id: "r", options: '{"depth":3}', tags: '["a","b"]' })).toEqual({
      run_id: "r",
      options: { depth: 3 },
      tags: ["a", "b"],
    });
  });

  test("a value of the wrong type is never sent as text under the right name", () => {
    const values = {
      run_id: "r",
      limit: "many",
      pages: "1.5",
      dry: "maybe",
      mode: "other",
      tags: '{"not":"a list"}',
      options: "{broken",
    };
    expect(buildInput(fields, values)).toEqual({ run_id: "r" });
    expect(invalidInputs(fields, values)).toEqual([
      "limit",
      "pages",
      "dry",
      "mode",
      "tags",
      "options",
    ]);
  });

  test("an empty field is not an invalid one", () => {
    expect(invalidInputs(fields, { run_id: "r", limit: "  " })).toEqual([]);
  });
});

describe("required fields", () => {
  const fields = inputFields(SCHEMA);

  test("names what is still missing", () => {
    expect(missingRequired(fields, {})).toEqual(["run_id", "mode"]);
    expect(missingRequired(fields, { run_id: "  ", mode: "live" })).toEqual(["run_id"]);
    expect(missingRequired(fields, { run_id: "r", mode: "live" })).toEqual([]);
  });
});

describe("a field that allows several types", () => {
  // Typed through `anyOf`, `oneOf` or a list — none of which is "text".
  const fields = inputFields({
    type: "object",
    properties: {
      amount: { anyOf: [{ type: "number" }, { type: "null" }] },
      target: { oneOf: [{ type: "string" }, { type: "integer" }] },
      filter: { type: ["object", "array"] },
      payload: {
        anyOf: [{ type: "object", properties: { id: { type: "string" } } }, { items: {} }],
      },
      note: { type: ["string", "null"] },
    },
  });
  const field = (name: string) => {
    const found = fields.find((entry) => entry.name === name);
    if (!found) throw new Error(`no field ${name}`);
    return found;
  };

  test("one real type beside null is that type, with its own control", () => {
    expect(field("amount").type).toBe("number");
    expect(inputControl(field("amount"))).toBe("number");
    expect(field("note").type).toBe("string");
    expect(buildInput(fields, { amount: "12.5" })).toEqual({ amount: 12.5 });
  });

  test("several types are one JSON value, named as such", () => {
    expect(field("target")).toMatchObject({ type: "any", union: ["string", "integer"] });
    expect(field("filter")).toMatchObject({ type: "any", union: ["object", "array"] });
    expect(field("payload")).toMatchObject({ type: "any", union: ["object", "array"] });
    expect(inputControl(field("target"))).toBe("json");
    expect(inputTypeKey(field("target"))).toBe("input.type.any");
  });

  test("a value is sent with its JSON type, never as text by default", () => {
    expect(buildInput(fields, { target: "42" })).toEqual({ target: 42 });
    expect(buildInput(fields, { filter: '{"a":1}' })).toEqual({ filter: { a: 1 } });
    expect(buildInput(fields, { filter: "[1,2]" })).toEqual({ filter: [1, 2] });
    // Plain text is text only where the field allows text.
    expect(buildInput(fields, { target: "north" })).toEqual({ target: "north" });
    expect(buildInput(fields, { target: '"42"' })).toEqual({ target: "42" });
  });

  test("a value of a type the field does not allow is named, not sent", () => {
    const values = { target: "1.5", filter: "north", payload: "7" };
    expect(buildInput(fields, values)).toEqual({});
    expect(invalidInputs(fields, values)).toEqual(["target", "filter", "payload"]);
  });
});

describe("an input schema that names no fields", () => {
  test("still takes input: the whole value is one JSON field", () => {
    for (const schema of [
      { type: "object" },
      { type: "object", additionalProperties: true },
      { type: "object", properties: {}, additionalProperties: true },
      { type: "array", items: { type: "string" } },
      { anyOf: [{ type: "object" }, { type: "array" }] },
    ]) {
      const form = inputForm(schema);
      expect(form.kind, JSON.stringify(schema)).toBe("whole");
      expect(formFields(form)).toHaveLength(1);
      expect(inputControl(formFields(form)[0] ?? { type: "string", options: null })).toBe("json");
    }
  });

  test("the whole value is the run's input, not a field inside it", () => {
    const object = inputForm({ type: "object" });
    expect(buildFormInput(object, { input: '{"id":"a"}' })).toEqual({ id: "a" });
    const list = inputForm({ type: "array", items: { type: "string" } });
    expect(buildFormInput(list, { input: '["a","b"]' })).toEqual(["a", "b"]);
    // Left empty: no input is sent, rather than an empty one.
    expect(buildFormInput(object, {})).toBeUndefined();
    // A list where an object belongs is refused, as for any field.
    expect(buildFormInput(object, { input: "[1]" })).toBeUndefined();
    expect(invalidInputs(formFields(object), { input: "[1]" })).toEqual(["input"]);
  });

  test("no schema, an empty one, or an object closed to any field takes nothing", () => {
    for (const schema of [
      null,
      {},
      { type: "object", properties: {} },
      { type: "object", additionalProperties: false },
    ]) {
      const form = inputForm(schema);
      expect(form.kind, JSON.stringify(schema)).toBe("none");
      expect(buildFormInput(form, { input: "{}" })).toBeUndefined();
    }
  });

  test("named fields stay named fields", () => {
    const form = inputForm(SCHEMA);
    expect(form.kind).toBe("fields");
    expect(buildFormInput(form, { run_id: "r" })).toEqual({ run_id: "r" });
  });
});
