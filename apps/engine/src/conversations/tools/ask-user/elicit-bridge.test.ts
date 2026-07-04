// ask_user_* ←→ MCP elicitation form-mode mapping — unit tests.
//
// Covers `mapAskUserToPrimitiveSchema` and `mapElicitResultToAskUserOutput`
// for all five form-bridge `ask_user_*` tools, including:
//   - the `ask_user_multi` `opt_<value>` boolean round-trip → string[]
//   - `ask_user_form` json/multi field degradation to DB-pause
//   - `ask_user_choice` returning null (decline-equivalent) on an
//     out-of-options value
//
// Pure functions — no DB, no network.

import { describe, expect, test } from "bun:test";
import {
  type FormBridgeToolName,
  mapAskUserToPrimitiveSchema,
  mapElicitResultToAskUserOutput,
} from "./elicit-bridge.ts";

function expectMapped(toolName: FormBridgeToolName, input: unknown) {
  const r = mapAskUserToPrimitiveSchema(toolName, input);
  if (r.degrade) throw new Error(`expected non-degrade mapping for ${toolName}`);
  return r;
}

describe("mapAskUserToPrimitiveSchema — ask_user_text", () => {
  test("maps question → { value: string } flat schema", () => {
    const r = expectMapped("ask_user_text", { question: "API key?" });
    expect(r.message).toBe("API key?");
    expect(r.requestedSchema.type).toBe("object");
    expect(r.requestedSchema.properties.value).toMatchObject({
      type: "string",
      description: "API key?",
    });
    expect(r.requestedSchema.required).toEqual(["value"]);
  });

  test("placeholder is surfaced as the property title", () => {
    const r = expectMapped("ask_user_text", { question: "Paste config", placeholder: "{...}" });
    expect(r.requestedSchema.properties.value).toMatchObject({ title: "{...}" });
  });

  test("degrades when question is missing", () => {
    expect(mapAskUserToPrimitiveSchema("ask_user_text", {}).degrade).toBe(true);
  });

  test("degrades on a non-object input", () => {
    expect(mapAskUserToPrimitiveSchema("ask_user_text", null).degrade).toBe(true);
  });
});

describe("mapAskUserToPrimitiveSchema — ask_user_choice", () => {
  test("maps options → a string enum + enumNames", () => {
    const r = expectMapped("ask_user_choice", {
      question: "Which environment?",
      options: [
        { value: "dev", label: "Development" },
        { value: "prod", label: "Production" },
      ],
    });
    expect(r.requestedSchema.properties.value).toMatchObject({
      type: "string",
      enum: ["dev", "prod"],
      enumNames: ["Development", "Production"],
    });
  });

  test("accepts bare string options (value === label)", () => {
    const r = expectMapped("ask_user_choice", { question: "Pick", options: ["a", "b"] });
    expect(r.requestedSchema.properties.value).toMatchObject({
      enum: ["a", "b"],
      enumNames: ["a", "b"],
    });
  });

  test("degrades on an empty options array", () => {
    expect(
      mapAskUserToPrimitiveSchema("ask_user_choice", { question: "Pick", options: [] }).degrade,
    ).toBe(true);
  });
});

describe("mapAskUserToPrimitiveSchema — ask_user_confirm", () => {
  test("maps to { confirmed: boolean, reason: string } with confirmed required", () => {
    const r = expectMapped("ask_user_confirm", { question: "Proceed?" });
    expect(r.requestedSchema.properties.confirmed).toMatchObject({ type: "boolean" });
    expect(r.requestedSchema.properties.reason).toMatchObject({ type: "string" });
    expect(r.requestedSchema.required).toEqual(["confirmed"]);
  });

  test("uses summary as the message when present", () => {
    const r = expectMapped("ask_user_confirm", { question: "Proceed?", summary: "Delete 3 rows" });
    expect(r.message).toBe("Delete 3 rows");
  });
});

describe("mapAskUserToPrimitiveSchema — ask_user_multi", () => {
  test("expands each option into one opt_<value> boolean property", () => {
    const r = expectMapped("ask_user_multi", {
      question: "Which skills?",
      options: [
        { value: "a", label: "Skill A" },
        { value: "b", label: "Skill B" },
      ],
    });
    expect(Object.keys(r.requestedSchema.properties).sort()).toEqual(["opt_a", "opt_b"]);
    expect(r.requestedSchema.properties.opt_a).toMatchObject({ type: "boolean", title: "Skill A" });
    // No `required` — a multi-select can legitimately be empty.
    expect(r.requestedSchema.required).toBeUndefined();
  });
});

describe("mapAskUserToPrimitiveSchema — ask_user_form", () => {
  test("maps flat primitive fields and tracks required", () => {
    const r = expectMapped("ask_user_form", {
      question: "Credentials",
      fields: [
        { name: "key", label: "API key", type: "text", required: true },
        { name: "count", label: "Count", type: "number" },
        { name: "enabled", label: "Enabled", type: "boolean" },
        {
          name: "env",
          label: "Environment",
          type: "select",
          options: [
            { value: "dev", label: "dev" },
            { value: "prod", label: "prod" },
          ],
        },
      ],
    });
    expect(r.requestedSchema.properties.key).toMatchObject({ type: "string" });
    expect(r.requestedSchema.properties.count).toMatchObject({ type: "number" });
    expect(r.requestedSchema.properties.enabled).toMatchObject({ type: "boolean" });
    expect(r.requestedSchema.properties.env).toMatchObject({
      type: "string",
      enum: ["dev", "prod"],
    });
    expect(r.requestedSchema.required).toEqual(["key"]);
  });

  test("password fields route to the sensitive arm — never a form property (A3)", () => {
    // MCP 2025-11-25 MUST: form-mode elicitation must not request secrets.
    // A password field no longer becomes a `{type:"string"}` form property;
    // the mapper returns the sensitive arm so the caller uses URL/portal mode.
    const r = mapAskUserToPrimitiveSchema("ask_user_form", {
      question: "Secret",
      fields: [{ name: "token", label: "Token", type: "password" }],
    });
    expect(r).toEqual({ degrade: true, sensitive: true, message: "Secret" });
  });

  test("degrades the whole form when ANY field is type json", () => {
    const r = mapAskUserToPrimitiveSchema("ask_user_form", {
      question: "Config",
      fields: [
        { name: "key", label: "Key", type: "text" },
        { name: "blob", label: "Blob", type: "json" },
      ],
    });
    expect(r.degrade).toBe(true);
  });

  test("degrades the whole form when ANY field is type multi", () => {
    const r = mapAskUserToPrimitiveSchema("ask_user_form", {
      question: "Pick",
      fields: [
        {
          name: "tags",
          label: "Tags",
          type: "multi",
          options: ["a", "b"],
        },
      ],
    });
    expect(r.degrade).toBe(true);
  });

  test("degrades a select field with no options", () => {
    const r = mapAskUserToPrimitiveSchema("ask_user_form", {
      question: "Pick",
      fields: [{ name: "env", label: "Env", type: "select" }],
    });
    expect(r.degrade).toBe(true);
  });
});

describe("mapElicitResultToAskUserOutput — ask_user_text", () => {
  test("passes the value through", () => {
    expect(mapElicitResultToAskUserOutput("ask_user_text", {}, { value: "abc" })).toEqual({
      value: "abc",
    });
  });

  test("missing value coerces to empty string", () => {
    expect(mapElicitResultToAskUserOutput("ask_user_text", {}, {})).toEqual({ value: "" });
  });
});

describe("mapElicitResultToAskUserOutput — ask_user_choice", () => {
  const input = {
    question: "Env?",
    options: [
      { value: "dev", label: "Development" },
      { value: "prod", label: "Production" },
    ],
  };

  test("a valid option resolves to { value, option_index }", () => {
    expect(mapElicitResultToAskUserOutput("ask_user_choice", input, { value: "prod" })).toEqual({
      value: "prod",
      option_index: 1,
    });
  });

  test("an out-of-options value returns null (decline-equivalent non-answer)", () => {
    // The requestedSchema pinned `enum` to exactly these values, so a
    // client returning anything else broke the contract — the mapper
    // returns null rather than silently persisting a phantom option.
    expect(
      mapElicitResultToAskUserOutput("ask_user_choice", input, { value: "staging" }),
    ).toBeNull();
  });

  test("an empty/absent value returns null", () => {
    expect(mapElicitResultToAskUserOutput("ask_user_choice", input, {})).toBeNull();
  });
});

describe("mapElicitResultToAskUserOutput — ask_user_confirm", () => {
  test("confirmed true with a reason", () => {
    expect(
      mapElicitResultToAskUserOutput(
        "ask_user_confirm",
        {},
        { confirmed: true, reason: "looks good" },
      ),
    ).toEqual({ confirmed: true, reason: "looks good" });
  });

  test("confirmed false drops an empty reason", () => {
    expect(mapElicitResultToAskUserOutput("ask_user_confirm", {}, { confirmed: false })).toEqual({
      confirmed: false,
    });
  });

  test("a non-boolean confirmed is a contract violation → null (decline-equivalent)", () => {
    expect(mapElicitResultToAskUserOutput("ask_user_confirm", {}, { confirmed: "yes" })).toBeNull();
  });
});

describe("mapElicitResultToAskUserOutput — ask_user_multi (opt_<value> round-trip)", () => {
  test("reassembles the opt_<value> booleans into the selected string[]", () => {
    const out = mapElicitResultToAskUserOutput(
      "ask_user_multi",
      {},
      { opt_a: true, opt_b: false, opt_c: true },
    );
    expect(out).toEqual({ values: ["a", "c"] });
  });

  test("all-false → empty values array", () => {
    expect(
      mapElicitResultToAskUserOutput("ask_user_multi", {}, { opt_a: false, opt_b: false }),
    ).toEqual({ values: [] });
  });

  test("ignores keys without the opt_ prefix", () => {
    expect(
      mapElicitResultToAskUserOutput("ask_user_multi", {}, { opt_a: true, stray: true }),
    ).toEqual({ values: ["a"] });
  });
});

describe("mapElicitResultToAskUserOutput — ask_user_form", () => {
  test("passes the primitive field map straight through", () => {
    expect(
      mapElicitResultToAskUserOutput("ask_user_form", {}, { key: "abc", count: 3, enabled: true }),
    ).toEqual({ key: "abc", count: 3, enabled: true });
  });

  test("undefined content yields an empty object", () => {
    expect(mapElicitResultToAskUserOutput("ask_user_form", {}, undefined)).toEqual({});
  });

  test("a nested-object field value is a contract violation → null (decline-equivalent)", () => {
    // The form `requestedSchema` only ever declares primitives; a client
    // returning a nested object broke the contract. The mapper collapses
    // to null rather than persisting the non-primitive onto `output`.
    expect(
      mapElicitResultToAskUserOutput("ask_user_form", {}, { field: { nested: true } }),
    ).toBeNull();
  });

  test("an array field value is also a contract violation → null", () => {
    expect(mapElicitResultToAskUserOutput("ask_user_form", {}, { tags: ["a", "b"] })).toBeNull();
  });

  test("a MIXED payload — one valid primitive + one nested object — is rejected whole", () => {
    // A partial-primitive payload must NOT be partially stripped: a single
    // non-primitive field poisons the entire output. The mapper returns
    // `null`, never `{ ok: "yes" }` — the valid primitive is dropped along
    // with the contract-violating one.
    expect(
      mapElicitResultToAskUserOutput("ask_user_form", {}, { ok: "yes", broken: { nested: true } }),
    ).toBeNull();
  });

  test("null field values are permitted primitives", () => {
    expect(mapElicitResultToAskUserOutput("ask_user_form", {}, { key: null })).toEqual({
      key: null,
    });
  });
});

// ── default forwarding — D1 bridge tests ────────────────────────────────────

describe("mapAskUserToPrimitiveSchema — default forwarding", () => {
  test("ask_user_text emits default on the requestedSchema value property", () => {
    const r = expectMapped("ask_user_text", {
      question: "Enter name",
      default: "Alice",
    });
    expect(r.requestedSchema.properties.value).toMatchObject({
      type: "string",
      default: "Alice",
    });
  });

  test("ask_user_text without default has no default key on the property", () => {
    const r = expectMapped("ask_user_text", { question: "Enter name" });
    expect((r.requestedSchema.properties.value as Record<string, unknown>).default).toBeUndefined();
  });

  test("ask_user_choice emits default when it matches one of the option values", () => {
    const r = expectMapped("ask_user_choice", {
      question: "Pick env",
      options: [
        { value: "dev", label: "Development" },
        { value: "prod", label: "Production" },
      ],
      default: "prod",
    });
    expect(r.requestedSchema.properties.value).toMatchObject({
      type: "string",
      default: "prod",
    });
  });

  test("ask_user_choice does NOT emit default when default is not among options", () => {
    const r = expectMapped("ask_user_choice", {
      question: "Pick env",
      options: [
        { value: "dev", label: "Development" },
        { value: "prod", label: "Production" },
      ],
      default: "staging",
    });
    expect((r.requestedSchema.properties.value as Record<string, unknown>).default).toBeUndefined();
  });

  test("ask_user_form text field emits string default on the property", () => {
    const r = expectMapped("ask_user_form", {
      question: "Config",
      fields: [{ name: "region", label: "Region", type: "text", default: "us-east-1" }],
    });
    expect(r.requestedSchema.properties.region).toMatchObject({
      type: "string",
      default: "us-east-1",
    });
  });

  test("ask_user_form number field emits numeric default on the property", () => {
    const r = expectMapped("ask_user_form", {
      question: "Config",
      fields: [{ name: "count", label: "Count", type: "number", default: 5 }],
    });
    expect(r.requestedSchema.properties.count).toMatchObject({
      type: "number",
      default: 5,
    });
  });

  test("ask_user_form boolean field emits boolean default on the property", () => {
    const r = expectMapped("ask_user_form", {
      question: "Config",
      fields: [{ name: "enabled", label: "Enabled", type: "boolean", default: false }],
    });
    expect(r.requestedSchema.properties.enabled).toMatchObject({
      type: "boolean",
      default: false,
    });
  });

  test("ask_user_form select field emits default on the property when matching an option", () => {
    const r = expectMapped("ask_user_form", {
      question: "Config",
      fields: [
        {
          name: "env",
          label: "Environment",
          type: "select",
          options: [
            { value: "dev", label: "dev" },
            { value: "prod", label: "prod" },
          ],
          default: "dev",
        },
      ],
    });
    expect(r.requestedSchema.properties.env).toMatchObject({
      type: "string",
      default: "dev",
    });
  });

  test("a field flagged sensitive:true (non-password) also routes to the sensitive arm (A3)", () => {
    // The sensitivity predicate is `type === "password" || sensitive === true`,
    // so a plain text field marked sensitive must not become a form property.
    const r = mapAskUserToPrimitiveSchema("ask_user_form", {
      question: "Credentials",
      fields: [{ name: "token", label: "Token", type: "text", sensitive: true }],
    });
    expect(r).toEqual({ degrade: true, sensitive: true, message: "Credentials" });
  });
});
