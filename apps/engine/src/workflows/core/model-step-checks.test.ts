import { describe, expect, test } from "bun:test";
import { compileJsonSchemaContract } from "../../execution/json-schema-contract.ts";
import { type ModelStep, ModelStepSchema } from "../types.ts";
import {
  MODEL_STEP_SECRET_PLACEHOLDER,
  modelStepPlaceholderRefusal,
  modelStepPlaceholders,
  modelStepValidationErrors,
} from "./model-step-checks.ts";
import { validateWorkflowDef } from "./validator.ts";

const verdict = { type: "object", properties: { category: { type: "string" } } };

function step(fields: Partial<ModelStep>): ModelStep {
  return ModelStepSchema.parse({
    id: "classify",
    kind: "model",
    prompt: "Classify",
    output_schema: verdict,
    ...fields,
  });
}

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
    expect(refusal?.details.refused).toEqual([
      { field: "prompt", token: "${cred.github.token}" },
      { field: "input.nested.0", token: "${connector.github.base_url}" },
      { field: "system", token: "${secret.me.api.token}" },
      { field: "system", token: "${connector.github.config.org}" },
    ]);
  });

  test("placeholders are found in prompt, system and nested input with their data path", () => {
    const found = modelStepPlaceholders(
      step({
        prompt: "Sort ${scope.fetch.data.body} for ${caller.email}",
        system: "Tone: ${state.tone}",
        input: { rows: ["${item.name}", { id: "${input.customer.id}" }], fixed: 3 },
      }),
    );
    expect(found).toEqual([
      {
        field: "prompt",
        kind: "scope",
        token: "${scope.fetch.data.body}",
        path: "scope.fetch.data.body",
      },
      { field: "prompt", kind: "caller", token: "${caller.email}", path: "caller.email" },
      { field: "system", kind: "state", token: "${state.tone}", path: "state.tone" },
      { field: "input.rows.0", kind: "item", token: "${item.name}", path: "item.name" },
      {
        field: "input.rows.1.id",
        kind: "input",
        token: "${input.customer.id}",
        path: "input.customer.id",
      },
    ]);
  });
});

describe("model step validation errors", () => {
  test("a step with a usable schema and data placeholders has no errors", () => {
    expect(
      modelStepValidationErrors(step({ prompt: "Sort ${input.text}" }), compileJsonSchemaContract),
    ).toEqual([]);
  });

  test("an output_schema that does not compile is named at its path", () => {
    const errors = modelStepValidationErrors(
      step({ output_schema: { type: "no-such-type" } }),
      compileJsonSchemaContract,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("steps.classify.output_schema");
    expect(errors[0]?.message).toStartWith("output_schema is not a valid JSON Schema: ");
  });

  test("vault, credential and connector placeholders are refused at save time", () => {
    const errors = modelStepValidationErrors(
      step({
        prompt: "Use ${secret.me.erp.password}",
        system: "Key ${cred.github.token}",
        input: { base: "${connector.github.base_url}" },
      }),
      compileJsonSchemaContract,
    );
    expect(errors.map((error) => error.path)).toEqual([
      "steps.classify.prompt",
      "steps.classify.system",
      "steps.classify.input.base",
    ]);
    expect(errors[0]?.message).toStartWith("${secret.me.erp.password}: A model step cannot use");
  });
});

describe("saving a workflow with a model step", () => {
  test("the validator reports the model step's errors", () => {
    const result = validateWorkflowDef({
      name: "sort",
      steps: [
        {
          id: "classify",
          kind: "model",
          prompt: "Use ${cred.github.token}",
          output_schema: { type: "no-such-type" },
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.path)).toEqual([
      "steps.classify.output_schema",
      "steps.classify.prompt",
    ]);
  });
});
