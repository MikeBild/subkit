// Schema-level unit tests for ask_user_* `default` field behaviour.
//
// What's covered:
//   - ask_user_form field schema:
//       text/number/boolean fields accept `default`
//       select `default` accepted when matching an option value; rejected otherwise
//       multi `default` accepted as string[] subset; rejected for non-subset
//       password fields: `default` REJECTED
//       sensitive:true fields: `default` REJECTED
//   - ask_user_choice: `default` accepted when equal to one option value; rejected otherwise
//   - ask_user_text: `default` string accepted
//
// Pure schema checks — no DB, no network.

import { describe, expect, test } from "bun:test";
import { askUserChoiceTool, askUserFormTool, askUserTextTool } from "../tools/ask-user/index.ts";

// ── ask_user_form — field `default` ─────────────────────────────────────────

describe("ask_user_form field default — text/number/boolean accepted", () => {
  test("text field accepts a string default", () => {
    const r = askUserFormTool.inputSchema.safeParse({
      question: "Config",
      fields: [{ name: "region", label: "Region", type: "text", default: "us-east-1" }],
    });
    expect(r.success).toBe(true);
  });

  test("number field accepts a numeric default", () => {
    const r = askUserFormTool.inputSchema.safeParse({
      question: "Config",
      fields: [{ name: "count", label: "Count", type: "number", default: 42 }],
    });
    expect(r.success).toBe(true);
  });

  test("boolean field accepts a boolean default", () => {
    const r = askUserFormTool.inputSchema.safeParse({
      question: "Config",
      fields: [{ name: "enabled", label: "Enabled", type: "boolean", default: true }],
    });
    expect(r.success).toBe(true);
  });
});

describe("ask_user_form field default — select validation", () => {
  test("select default accepted when it matches one of the declared option values", () => {
    const r = askUserFormTool.inputSchema.safeParse({
      question: "Pick env",
      fields: [
        {
          name: "env",
          label: "Environment",
          type: "select",
          options: [
            { value: "dev", label: "Development" },
            { value: "prod", label: "Production" },
          ],
          default: "dev",
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  test("select default REJECTED when it does not match any option value", () => {
    const r = askUserFormTool.inputSchema.safeParse({
      question: "Pick env",
      fields: [
        {
          name: "env",
          label: "Environment",
          type: "select",
          options: [
            { value: "dev", label: "Development" },
            { value: "prod", label: "Production" },
          ],
          default: "staging",
        },
      ],
    });
    expect(r.success).toBe(false);
  });
});

describe("ask_user_form field default — multi validation", () => {
  test("multi default accepted as string[] subset of declared options", () => {
    const r = askUserFormTool.inputSchema.safeParse({
      question: "Skills",
      fields: [
        {
          name: "tags",
          label: "Tags",
          type: "multi",
          options: ["alpha", "beta", "gamma"],
          default: ["alpha", "gamma"],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  test("multi default REJECTED when it contains a value outside the declared options", () => {
    const r = askUserFormTool.inputSchema.safeParse({
      question: "Skills",
      fields: [
        {
          name: "tags",
          label: "Tags",
          type: "multi",
          options: ["alpha", "beta"],
          default: ["alpha", "delta"],
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  test("multi default REJECTED when it is not an array", () => {
    const r = askUserFormTool.inputSchema.safeParse({
      question: "Skills",
      fields: [
        {
          name: "tags",
          label: "Tags",
          type: "multi",
          options: ["alpha", "beta"],
          default: "alpha",
        },
      ],
    });
    expect(r.success).toBe(false);
  });
});

describe("ask_user_form field default — password/sensitive REJECTED", () => {
  test("password field: default REJECTED (secrets must not be pre-filled)", () => {
    const r = askUserFormTool.inputSchema.safeParse({
      question: "Credentials",
      fields: [
        {
          name: "token",
          label: "API Token",
          type: "password",
          default: "secret123",
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  test("sensitive:true text field: default REJECTED", () => {
    const r = askUserFormTool.inputSchema.safeParse({
      question: "Credentials",
      fields: [
        {
          name: "secret",
          label: "Secret",
          type: "text",
          sensitive: true,
          default: "mysecret",
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  test("password field without default passes", () => {
    const r = askUserFormTool.inputSchema.safeParse({
      question: "Credentials",
      fields: [{ name: "token", label: "Token", type: "password" }],
    });
    expect(r.success).toBe(true);
  });
});

// ── ask_user_choice — `default` validation ──────────────────────────────────

describe("ask_user_choice default", () => {
  test("default accepted when equal to one of the option values", () => {
    const r = askUserChoiceTool.inputSchema.safeParse({
      question: "Environment?",
      options: [
        { value: "dev", label: "Development" },
        { value: "prod", label: "Production" },
      ],
      default: "prod",
    });
    expect(r.success).toBe(true);
  });

  test("default REJECTED when it does not match any option value", () => {
    const r = askUserChoiceTool.inputSchema.safeParse({
      question: "Environment?",
      options: [
        { value: "dev", label: "Development" },
        { value: "prod", label: "Production" },
      ],
      default: "staging",
    });
    expect(r.success).toBe(false);
  });

  test("input without default is accepted", () => {
    const r = askUserChoiceTool.inputSchema.safeParse({
      question: "Environment?",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    });
    expect(r.success).toBe(true);
  });
});

// ── ask_user_text — `default` accepted ──────────────────────────────────────

describe("ask_user_text default", () => {
  test("string default accepted", () => {
    const r = askUserTextTool.inputSchema.safeParse({
      question: "Enter name",
      default: "John Doe",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as { default?: string }).default).toBe("John Doe");
    }
  });

  test("omitting default is fine", () => {
    const r = askUserTextTool.inputSchema.safeParse({ question: "Enter name" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as { default?: string }).default).toBeUndefined();
    }
  });
});
