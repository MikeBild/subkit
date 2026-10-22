import { describe, expect, test } from "bun:test";
import {
  buildSchemaInput,
  fieldTitle,
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
