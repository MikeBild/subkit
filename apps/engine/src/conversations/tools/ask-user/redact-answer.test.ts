// #304 — field-metadata-driven redaction of elicitation answers before
// persistence / LLM replay. The raw value still flows through the
// in-memory outcome pipeline; only the persisted projection is masked.

import { describe, expect, test } from "bun:test";
import { ELICITATION_REDACTED_MARKER, redactElicitationOutput } from "./redact-answer.ts";

const formInput = (fields: Array<Record<string, unknown>>) => ({ fields });

describe("redactElicitationOutput — ask_user_form", () => {
  test("password + sensitive fields become the marker; non-secret fields byte-identical", () => {
    const input = formInput([
      { name: "base_url", label: "Base URL", type: "text" },
      { name: "api_token", label: "API token", type: "password" },
      { name: "client_secret", label: "Client secret", type: "text", sensitive: true },
    ]);
    const output = {
      values: {
        base_url: "https://api.example.com",
        api_token: "hunter2",
        client_secret: "s3kr3t",
      },
    };
    const redacted = redactElicitationOutput("ask_user_form", input, output) as {
      values: Record<string, string>;
    };
    expect(redacted.values.base_url).toBe("https://api.example.com");
    expect(redacted.values.api_token).toBe(ELICITATION_REDACTED_MARKER);
    expect(redacted.values.client_secret).toBe(ELICITATION_REDACTED_MARKER);
    // The caller's raw object is untouched (still needed by the outcome pipeline).
    expect(output.values.api_token).toBe("hunter2");
  });

  test("flat value map (MCP-bridge shape, no `values` wrapper) is redacted too", () => {
    const input = formInput([{ name: "token", label: "Token", type: "password" }]);
    const output = { token: "plain-low-entropy-pw" };
    const redacted = redactElicitationOutput("ask_user_form", input, output) as Record<
      string,
      string
    >;
    expect(redacted.token).toBe(ELICITATION_REDACTED_MARKER);
  });

  test("a form with no secret fields passes through unchanged (same reference-equal value)", () => {
    const input = formInput([{ name: "name", label: "Name", type: "text" }]);
    const output = { values: { name: "acme" } };
    expect(redactElicitationOutput("ask_user_form", input, output)).toBe(output);
  });

  test("an empty-string secret answer is left as-is (nothing to hide)", () => {
    const input = formInput([{ name: "token", label: "Token", type: "password" }]);
    const output = { values: { token: "" } };
    const redacted = redactElicitationOutput("ask_user_form", input, output) as {
      values: Record<string, string>;
    };
    expect(redacted.values.token).toBe("");
  });
});

describe("redactElicitationOutput — ask_user_text", () => {
  test("a pasted vendor token in the answer is span-redacted; surrounding prose intact", () => {
    const output = { text: "here is my key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX please use it" };
    const redacted = redactElicitationOutput("ask_user_text", {}, output) as { text: string };
    expect(redacted.text).toContain("here is my key ");
    expect(redacted.text).toContain(" please use it");
    expect(redacted.text).toContain(ELICITATION_REDACTED_MARKER);
    expect(redacted.text).not.toContain("sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX");
  });

  test("ordinary prose without a secret shape is left untouched", () => {
    const output = { text: "please deploy the staging environment tomorrow morning" };
    const redacted = redactElicitationOutput("ask_user_text", {}, output) as { text: string };
    expect(redacted.text).toBe("please deploy the staging environment tomorrow morning");
  });

  test("the MCP-bridge `{ value }` shape is redacted the same as `{ text }`", () => {
    const output = { value: "token ghp_1234567890abcdefABCDEF1234567890abcdef here" };
    const redacted = redactElicitationOutput("ask_user_text", {}, output) as { value: string };
    expect(redacted.value).toContain(ELICITATION_REDACTED_MARKER);
    expect(redacted.value).not.toContain("ghp_1234567890abcdefABCDEF1234567890abcdef");
  });
});

describe("redactElicitationOutput — passthrough tools", () => {
  test("choice / multi / confirm / null answers are returned unchanged", () => {
    const choice = { value: "option-a" };
    expect(redactElicitationOutput("ask_user_choice", {}, choice)).toBe(choice);
    const multi = { values: ["a", "b"] };
    expect(redactElicitationOutput("ask_user_multi", {}, multi)).toBe(multi);
    const confirm = { confirmed: true };
    expect(redactElicitationOutput("ask_user_confirm", {}, confirm)).toBe(confirm);
    expect(redactElicitationOutput("ask_user_form", {}, null)).toBeNull();
  });

  test("a declined form answer (no secret values present) passes through", () => {
    const input = formInput([{ name: "token", label: "Token", type: "password" }]);
    const declined = { confirmed: false };
    // No secret value in the answer map → nothing changes materially.
    const redacted = redactElicitationOutput("ask_user_form", input, declined) as Record<
      string,
      unknown
    >;
    expect(redacted.confirmed).toBe(false);
  });
});
