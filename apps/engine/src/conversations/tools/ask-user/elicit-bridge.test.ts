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

  test("password fields map to plain string primitives", () => {
    const r = expectMapped("ask_user_form", {
      question: "Secret",
      fields: [{ name: "token", label: "Token", type: "password" }],
    });
    expect(r.requestedSchema.properties.token).toMatchObject({ type: "string" });
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

  test("a non-boolean confirmed coerces to false", () => {
    expect(mapElicitResultToAskUserOutput("ask_user_confirm", {}, { confirmed: "yes" })).toEqual({
      confirmed: false,
    });
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
});
