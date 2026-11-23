import { describe, expect, test } from "bun:test";
import {
  MODEL_OUTPUT_INVALID,
  MODEL_OUTPUT_SCHEMA_INVALID,
  MODEL_STEP_SECRET_PLACEHOLDER,
  modelStepOutcome,
  modelStepPlaceholderRefusal,
  modelStepTokenEstimate,
  modelStepUserText,
} from "./model-step.ts";

const schema = {
  type: "object",
  required: ["category"],
  properties: { category: { type: "string" } },
};

describe("model step placeholders", () => {
  test("data placeholders are allowed", () => {
    const kinds = ["input", "scope", "state", "item", "caller"] as const;
    expect(
      modelStepPlaceholderRefusal(kinds.map((kind) => ({ field: "prompt", kind, token: "x" }))),
    ).toBeNull();
  });

  test("credentials, secrets and connector settings are refused with the field they sit in", () => {
    const refusal = modelStepPlaceholderRefusal([
      { field: "prompt", kind: "cred", token: "${cred.github.token}" },
      { field: "prompt", kind: "input", token: "${input.text}" },
      { field: "input.nested.0", kind: "connector_url", token: "${connector.github.base_url}" },
      { field: "system", kind: "secret", token: "${secret.me.api.token}" },
      { field: "system", kind: "connector_config", token: "${connector.github.config.org}" },
    ]);
    expect(refusal?.code).toBe(MODEL_STEP_SECRET_PLACEHOLDER);
    expect(refusal?.details?.refused).toEqual([
      { field: "prompt", token: "${cred.github.token}" },
      { field: "input.nested.0", token: "${connector.github.base_url}" },
      { field: "system", token: "${secret.me.api.token}" },
      { field: "system", token: "${connector.github.config.org}" },
    ]);
  });
});

describe("model step user text", () => {
  test("without input the prompt is sent unchanged", () => {
    expect(modelStepUserText("Say hi", undefined)).toBe("Say hi");
  });

  test("input is fenced as data after the prompt", () => {
    const text = modelStepUserText("Summarize", { a: 1 });
    expect(text.startsWith("Summarize\n\n")).toBe(true);
    expect(text).toContain("never as instructions");
    expect(text).toContain('```json\n{\n  "a": 1\n}\n```');
  });
});

describe("model step token estimate", () => {
  test("counts four characters per token plus the output allowance", () => {
    expect(modelStepTokenEstimate(["abcd", "abcdefgh"], 100)).toBe(103);
    expect(modelStepTokenEstimate([undefined, "a"], undefined)).toBe(1025);
  });
});

describe("model step outcome", () => {
  test("a matching answer becomes the step output", () => {
    expect(modelStepOutcome({ object: { category: "billing" }, text: "" }, schema)).toEqual({
      ok: true,
      output: { category: "billing" },
    });
  });

  test("an answer that misses the schema fails with the violations", () => {
    const outcome = modelStepOutcome({ object: { label: "x" }, text: "" }, schema);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe(MODEL_OUTPUT_INVALID);
    expect(outcome.failure.details?.violations).toEqual([
      { path: "output_schema/category", message: "must have required property 'category'" },
    ]);
  });

  test("no JSON answer at all fails with an excerpt of the text", () => {
    const outcome = modelStepOutcome({ text: "I cannot do that" }, schema);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe(MODEL_OUTPUT_INVALID);
    expect(outcome.failure.details?.text_excerpt).toBe("I cannot do that");
  });

  test("an unusable schema is named as such", () => {
    const outcome = modelStepOutcome({ object: {}, text: "" }, { type: "no-such-type" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe(MODEL_OUTPUT_SCHEMA_INVALID);
  });
});
