import { describe, expect, test } from "bun:test";
import {
  flattenInputFields,
  formFields,
  inputFields,
  inputForm,
  inputItemTypeKey,
  inputSampleText,
  inputTypeKey,
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
      title: null,
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
});

describe("a field that allows several types", () => {
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
    expect(field("note").type).toBe("string");
  });

  test("several types are one JSON value, named as such", () => {
    expect(field("target")).toMatchObject({ type: "any", union: ["string", "integer"] });
    expect(field("filter")).toMatchObject({ type: "any", union: ["object", "array"] });
    expect(field("payload")).toMatchObject({ type: "any", union: ["object", "array"] });
    expect(inputTypeKey(field("target"))).toBe("input.type.any");
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
    }
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
    }
  });

  test("named fields stay named fields", () => {
    const form = inputForm(SCHEMA);
    expect(form.kind).toBe("fields");
  });
});
