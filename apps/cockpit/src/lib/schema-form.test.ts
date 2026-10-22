import { describe, expect, test } from "bun:test";
import { inputForm } from "@/lib/workflow-inputs";
import {
  buildFormSchemaInput,
  buildSchemaInput,
  fieldTitle,
  formValuesFromInput,
  initialSchemaValues,
  schemaFieldKind,
  schemaFields,
  valuesFromInput,
} from "./schema-form";

const schema = {
  type: "object",
  required: ["org", "limit"],
  properties: {
    org: { type: "string", title: "Organisation", description: "GitHub-Name" },
    limit: { type: "integer", default: 10 },
    skip_archived: { type: "boolean", default: true },
    state: { type: "string", enum: ["open", "closed", "all"] },
    languages: { type: "array", items: { type: "string" } },
    notify: {
      type: "object",
      required: ["email"],
      properties: { email: { type: "string" }, subject: { type: "string" } },
    },
    raw: { type: "object" },
  },
};

const fields = schemaFields(schema);
const field = (name: string) => fields.find((entry) => entry.name === name)!;

describe("schema form model", () => {
  test("every schema shape gets a plain control instead of a JSON box", () => {
    expect(fields.map((entry) => [entry.name, schemaFieldKind(entry)])).toEqual([
      ["org", "text"],
      ["limit", "number"],
      ["skip_archived", "boolean"],
      ["state", "enum"],
      ["languages", "list"],
      ["notify", "group"],
      ["raw", "json"],
    ]);
  });

  test("labels use the schema title, else a readable name, never the raw key", () => {
    expect(fieldTitle(field("org"))).toBe("Organisation");
    expect(fieldTitle(field("skip_archived"))).toBe("Skip archived");
  });

  test("defaults fill the form, nested groups included", () => {
    expect(initialSchemaValues(fields)).toEqual({
      org: "",
      limit: "10",
      skip_archived: true,
      state: "",
      languages: [],
      notify: { email: "", subject: "" },
      raw: "",
    });
  });

  test("filled values become typed input; empty optional ones are left out", () => {
    const values = {
      ...initialSchemaValues(fields),
      org: "github",
      limit: "25",
      state: "open",
      languages: ["TypeScript", " ", "Go"],
      notify: { email: "team@example.com", subject: "" },
      raw: '{"a":1}',
    };
    expect(buildSchemaInput(fields, values)).toEqual({
      input: {
        org: "github",
        limit: 25,
        skip_archived: true,
        state: "open",
        languages: ["TypeScript", "Go"],
        notify: { email: "team@example.com" },
        raw: { a: 1 },
      },
      errors: [],
    });
  });

  test("missing, non-numeric and broken values are named by field", () => {
    const values = {
      ...initialSchemaValues(fields),
      limit: "2.5",
      notify: { email: "", subject: "x" },
      raw: "{",
    };
    expect(
      buildSchemaInput(fields, values).errors.map((error) => [error.path, error.problem]),
    ).toEqual([
      ["org", "missing"],
      ["limit", "integer"],
      ["notify.email", "missing"],
      ["raw", "json"],
    ]);
    expect(
      buildSchemaInput(fields, { ...values, org: "a", limit: "zehn" }).errors[0]?.problem,
    ).toBe("number");
  });

  test("JSON typed in the technical box round-trips into the form", () => {
    const input = { org: "acme", limit: 3, languages: ["Go"], notify: { email: "a@b.c" } };
    const values = valuesFromInput(fields, input);
    expect(values.limit).toBe("3");
    expect(values.languages).toEqual(["Go"]);
    expect(buildSchemaInput(fields, values).input).toEqual({
      ...input,
      skip_archived: false,
    });
  });
});

describe("schema form for a whole workflow input", () => {
  test("a schema without fields still runs, unwrapped from its single box", () => {
    const form = inputForm({ type: "array", items: { type: "string" } });
    expect(form.kind).toBe("whole");
    const values = formValuesFromInput(form, ["a", "b"]);
    expect(buildFormSchemaInput(form, values)).toEqual({ input: ["a", "b"], errors: [] });
  });

  test("no schema means no input at all", () => {
    expect(buildFormSchemaInput(inputForm(null), {})).toEqual({ input: undefined, errors: [] });
  });

  test("a saved input refills the fields and an empty one keeps the defaults", () => {
    const form = inputForm(schema);
    const saved = formValuesFromInput(form, { org: "github", limit: 5 });
    expect(saved.org).toBe("github");
    expect(saved.limit).toBe("5");
    expect(formValuesFromInput(form, {}).limit).toBe("10");
  });
});

describe("schema form for a field that allows several types", () => {
  const form = inputForm({
    type: "object",
    properties: {
      target: { oneOf: [{ type: "string" }, { type: "integer" }] },
      filter: { type: ["object", "array"] },
      payload: {
        anyOf: [{ type: "object", properties: { id: { type: "string" } } }, { items: {} }],
      },
    },
  });

  test("a value is sent with its JSON type, falling back to text only where text is allowed", () => {
    const run = (values: Record<string, string>) => buildFormSchemaInput(form, values);
    expect(run({ target: "42" }).input).toEqual({ target: 42 });
    expect(run({ filter: '{"a":1}' }).input).toEqual({ filter: { a: 1 } });
    expect(run({ filter: "[1,2]" }).input).toEqual({ filter: [1, 2] });
    expect(run({ target: "north" }).input).toEqual({ target: "north" });
    expect(run({ target: '"42"' }).input).toEqual({ target: "42" });
  });

  test("a value of a type the field does not allow is named, not sent", () => {
    const built = buildFormSchemaInput(form, { target: "1.5", filter: "north", payload: "7" });
    expect(built.input).toEqual({});
    expect(built.errors.map((error) => error.path)).toEqual(["target", "filter", "payload"]);
  });

  test("a whole object input refuses a list", () => {
    const object = inputForm({ type: "object" });
    expect(buildFormSchemaInput(object, { input: '{"id":"a"}' }).input).toEqual({ id: "a" });
    expect(buildFormSchemaInput(object, { input: "[1]" }).errors).toHaveLength(1);
    expect(buildFormSchemaInput(object, {}).input).toBeUndefined();
  });
});
