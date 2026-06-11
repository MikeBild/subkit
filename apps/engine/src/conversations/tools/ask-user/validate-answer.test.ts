// Unit tests for validateElicitationAnswer.
//
// What's covered:
//   - ask_user_form:
//       required field missing → field error
//       json field with invalid JSON string → error (via validateFormFieldValue)
//       valid submission → ok:true
//       output wrapped as {values:{...}} AND flat map both supported
//       decline {confirmed:false} always ok:true
//   - ask_user_text:
//       validation_regex mismatch on {text} and {value} shapes → error
//       regex match → ok
//       invalid regex pattern → ok (passes open)
//   - ask_user_choice:
//       out-of-options value → error
//       valid → ok
//   - ask_user_multi:
//       value outside options → error
//       min violation → error
//       max violation → error
//       valid → ok
//
// Pure functions — no DB, no network.

import { describe, expect, test } from "bun:test";
import { validateElicitationAnswer } from "./validate-answer.ts";

// ── ask_user_form ────────────────────────────────────────────────────────────

const formInput = {
  question: "Credentials",
  fields: [
    { name: "username", label: "Username", type: "text" as const, required: true },
    { name: "nickname", label: "Nickname", type: "text" as const, required: false },
    { name: "config_json", label: "Config JSON", type: "json" as const, required: true },
  ],
};

describe("validateElicitationAnswer — ask_user_form", () => {
  test("required field missing → field error naming the field", () => {
    const result = validateElicitationAnswer("ask_user_form", formInput, { username: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const names = result.field_errors.map((e) => e.name);
      expect(names).toContain("username");
    }
  });

  test("json field with invalid JSON string → error", () => {
    const result = validateElicitationAnswer("ask_user_form", formInput, {
      username: "alice",
      config_json: "{ broken json",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const jsonErr = result.field_errors.find((e) => e.name === "config_json");
      expect(jsonErr).toBeDefined();
      expect(jsonErr?.message).toContain("invalid JSON");
    }
  });

  test("valid flat-map submission → ok:true", () => {
    const result = validateElicitationAnswer("ask_user_form", formInput, {
      username: "alice",
      config_json: '{"key":"value"}',
    });
    expect(result.ok).toBe(true);
  });

  test("wrapped {values:{...}} output also accepted", () => {
    const result = validateElicitationAnswer("ask_user_form", formInput, {
      values: { username: "bob", config_json: '{"x":1}' },
    });
    expect(result.ok).toBe(true);
  });

  test("decline {confirmed:false} always ok:true even with missing required fields", () => {
    const result = validateElicitationAnswer("ask_user_form", formInput, { confirmed: false });
    expect(result.ok).toBe(true);
  });

  test("decline via {declined:true} always ok:true", () => {
    const result = validateElicitationAnswer("ask_user_form", formInput, { declined: true });
    expect(result.ok).toBe(true);
  });

  test("optional field absent → no error", () => {
    // nickname is optional; username + config_json filled
    const result = validateElicitationAnswer("ask_user_form", formInput, {
      username: "alice",
      config_json: "{}",
    });
    expect(result.ok).toBe(true);
  });

  test("null or undefined input/output → ok:true (no crash)", () => {
    expect(validateElicitationAnswer("ask_user_form", null, null).ok).toBe(true);
    expect(validateElicitationAnswer("ask_user_form", undefined, undefined).ok).toBe(true);
  });
});

// ── ask_user_text ────────────────────────────────────────────────────────────

describe("validateElicitationAnswer — ask_user_text", () => {
  const regexInput = { question: "Enter a date", validation_regex: "^\\d{4}-\\d{2}-\\d{2}$" };

  test("validation_regex mismatch on {text} shape → error", () => {
    const result = validateElicitationAnswer("ask_user_text", regexInput, { text: "not-a-date" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field_errors).toHaveLength(1);
      expect(result.field_errors[0]?.name).toBe("text");
    }
  });

  test("validation_regex mismatch on {value} shape → error", () => {
    const result = validateElicitationAnswer("ask_user_text", regexInput, {
      value: "not-a-date",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field_errors[0]?.name).toBe("text");
    }
  });

  test("regex match on {text} shape → ok:true", () => {
    const result = validateElicitationAnswer("ask_user_text", regexInput, { text: "2026-06-11" });
    expect(result.ok).toBe(true);
  });

  test("regex match on {value} shape → ok:true", () => {
    const result = validateElicitationAnswer("ask_user_text", regexInput, {
      value: "2026-06-11",
    });
    expect(result.ok).toBe(true);
  });

  test("invalid regex pattern → ok:true (passes open, never blocks operator)", () => {
    const result = validateElicitationAnswer(
      "ask_user_text",
      { question: "Enter something", validation_regex: "[unclosed" },
      { text: "anything" },
    );
    expect(result.ok).toBe(true);
  });

  test("no validation_regex → always ok:true", () => {
    const result = validateElicitationAnswer(
      "ask_user_text",
      { question: "Free text" },
      { text: "whatever" },
    );
    expect(result.ok).toBe(true);
  });
});

// ── ask_user_choice ──────────────────────────────────────────────────────────

describe("validateElicitationAnswer — ask_user_choice", () => {
  const choiceInput = {
    question: "Pick",
    options: [
      { value: "dev", label: "Development" },
      { value: "prod", label: "Production" },
    ],
  };

  test("out-of-options value → error", () => {
    const result = validateElicitationAnswer("ask_user_choice", choiceInput, {
      value: "staging",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field_errors[0]?.name).toBe("value");
      expect(result.field_errors[0]?.message).toContain("staging");
    }
  });

  test("valid in-options value → ok:true", () => {
    const result = validateElicitationAnswer("ask_user_choice", choiceInput, { value: "dev" });
    expect(result.ok).toBe(true);
  });

  test("missing value (no output.value key) → ok:true (treated as no-answer)", () => {
    const result = validateElicitationAnswer("ask_user_choice", choiceInput, {});
    expect(result.ok).toBe(true);
  });
});

// ── ask_user_multi ───────────────────────────────────────────────────────────

describe("validateElicitationAnswer — ask_user_multi", () => {
  const multiInput = {
    question: "Which?",
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
      { value: "c", label: "C" },
    ],
    min: 1,
    max: 2,
  };

  test("value outside the declared options → error", () => {
    const result = validateElicitationAnswer("ask_user_multi", multiInput, { values: ["x"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field_errors[0]?.message).toContain('"x"');
    }
  });

  test("min violation → error", () => {
    // min=1 but zero selections
    const result = validateElicitationAnswer("ask_user_multi", multiInput, { values: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const minErr = result.field_errors.find((e) => e.message.includes("at least"));
      expect(minErr).toBeDefined();
    }
  });

  test("max violation → error", () => {
    // max=2 but three selections
    const result = validateElicitationAnswer("ask_user_multi", multiInput, {
      values: ["a", "b", "c"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const maxErr = result.field_errors.find((e) => e.message.includes("at most"));
      expect(maxErr).toBeDefined();
    }
  });

  test("valid subset within min/max → ok:true", () => {
    const result = validateElicitationAnswer("ask_user_multi", multiInput, { values: ["a", "b"] });
    expect(result.ok).toBe(true);
  });

  test("output without values key → ok:true (no values to validate)", () => {
    const result = validateElicitationAnswer("ask_user_multi", multiInput, {});
    expect(result.ok).toBe(true);
  });
});

// ── unknown tool name ────────────────────────────────────────────────────────

describe("validateElicitationAnswer — unknown tool", () => {
  test("unknown tool_name always returns ok:true", () => {
    const result = validateElicitationAnswer("some_future_tool", { question: "?" }, { x: 1 });
    expect(result.ok).toBe(true);
  });
});
