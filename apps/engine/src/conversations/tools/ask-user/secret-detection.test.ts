// Unit tests for the D7 secret-shaped elicitation detector.

import { describe, expect, test } from "bun:test";
import { detectSecretElicitation } from "./secret-detection.ts";

describe("detectSecretElicitation — ask_user_form", () => {
  test("password field is a secret elicitation", () => {
    const hit = detectSecretElicitation("ask_user_form", {
      question: "Enter credentials",
      fields: [{ name: "token", label: "Token", type: "password" }],
    });
    expect(hit).toEqual({ reason: "password_field", field: "token" });
  });

  test("sensitive:true field is a secret elicitation", () => {
    const hit = detectSecretElicitation("ask_user_form", {
      question: "Enter credentials",
      fields: [{ name: "secret", label: "Secret", type: "text", sensitive: true }],
    });
    expect(hit).toEqual({ reason: "sensitive_flag", field: "secret" });
  });

  test("an UNMARKED but secret-named text field is caught (name)", () => {
    // The classic bypass: a plain `text` field named `api_key` with no
    // password type and no sensitive flag — SENSITIVE_KEY_PATTERN catches it.
    const hit = detectSecretElicitation("ask_user_form", {
      question: "Connect",
      fields: [{ name: "api_key", label: "Key", type: "text" }],
    });
    expect(hit).toEqual({ reason: "secret_field_name", field: "api_key" });
  });

  test("an UNMARKED text field with a secret-shaped label is caught (label)", () => {
    const hit = detectSecretElicitation("ask_user_form", {
      question: "Connect",
      fields: [{ name: "value", label: "Bearer Token", type: "text" }],
    });
    expect(hit).toEqual({ reason: "secret_field_name", field: "value" });
  });

  test("a placeholder carrying a concrete secret value is caught", () => {
    const hit = detectSecretElicitation("ask_user_form", {
      question: "Connect",
      fields: [
        {
          name: "region",
          label: "Region",
          type: "text",
          placeholder: "e.g. ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
        },
      ],
    });
    expect(hit?.reason).toBe("secret_literal");
    expect(hit?.field).toBe("region");
  });

  test("a purely non-secret form is NOT flagged", () => {
    const hit = detectSecretElicitation("ask_user_form", {
      question: "Configure the sync",
      fields: [
        { name: "region", label: "Region", type: "text" },
        { name: "count", label: "Count", type: "number" },
        { name: "enabled", label: "Enabled", type: "boolean" },
      ],
    });
    expect(hit).toBeNull();
  });
});

describe("detectSecretElicitation — ask_user_text", () => {
  test("a question that reads as a secret request is flagged", () => {
    for (const question of [
      "Paste your API key",
      "What is your access token?",
      "Enter the password for the account",
      "Provide the client secret",
    ]) {
      const hit = detectSecretElicitation("ask_user_text", { question });
      expect(hit).toEqual({ reason: "secret_question", field: "question" });
    }
  });

  test("a mundane question is NOT flagged", () => {
    const hit = detectSecretElicitation("ask_user_text", {
      question: "What should the workflow be named?",
    });
    expect(hit).toBeNull();
  });

  test("a concrete secret leaked into the default is caught", () => {
    const hit = detectSecretElicitation("ask_user_text", {
      question: "Confirm the value",
      default: "dop_v1_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
    });
    expect(hit?.reason).toBe("secret_literal");
  });
});

describe("detectSecretElicitation — non-vector tools", () => {
  test("ask_user_choice / ask_user_confirm / ask_user_multi are never flagged", () => {
    expect(
      detectSecretElicitation("ask_user_choice", {
        question: "Pick your secret store",
        options: [{ value: "a", label: "A" }],
      }),
    ).toBeNull();
    expect(
      detectSecretElicitation("ask_user_confirm", { question: "Rotate the token?" }),
    ).toBeNull();
    expect(
      detectSecretElicitation("ask_user_multi", { question: "Which secrets?", options: ["a"] }),
    ).toBeNull();
  });

  test("non-object / null input is safe", () => {
    expect(detectSecretElicitation("ask_user_text", null)).toBeNull();
    expect(detectSecretElicitation("ask_user_form", "nope")).toBeNull();
  });
});
