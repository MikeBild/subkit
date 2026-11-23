import { wrapUntrusted } from "@shared/untrusted-content.ts";
import { checkJsonSchemaContract } from "../json-schema-contract.ts";

export const MODEL_OUTPUT_INVALID = "model_output_invalid";
export const MODEL_OUTPUT_SCHEMA_INVALID = "model_output_schema_invalid";

const CHARS_PER_TOKEN = 4;
const MAX_REPORTED_VIOLATIONS = 20;

export interface ModelStepFailure {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ModelStepOutcome =
  | { ok: true; output: unknown }
  | { ok: false; failure: ModelStepFailure };

function unescapeDoubleDollar(text: string): string {
  return text.replaceAll("$${", "${");
}

function framed(value: unknown): string {
  return wrapUntrusted(
    "workflow",
    typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "null"),
  );
}

export interface ModelStepFrameToken {
  raw: string;
  span: { start: number; end: number };
}

export function modelStepFrameText(
  template: string,
  tokens: ReadonlyArray<ModelStepFrameToken>,
  values: ReadonlyMap<string, unknown>,
): string {
  let out = "";
  let cursor = 0;
  for (const token of tokens) {
    out += unescapeDoubleDollar(template.slice(cursor, token.span.start));
    out += values.has(token.raw) ? framed(values.get(token.raw)) : token.raw;
    cursor = token.span.end;
  }
  return out + unescapeDoubleDollar(template.slice(cursor));
}

export function modelStepUserText(prompt: string, input: unknown): string {
  if (input === undefined) return prompt;
  return [prompt, "Input data:", framed(input)].join("\n\n");
}

export function modelStepTokenEstimate(
  texts: ReadonlyArray<string | undefined>,
  maxOutputTokens: number,
): number {
  const chars = texts.reduce((sum, text) => sum + (text?.length ?? 0), 0);
  return Math.ceil(chars / CHARS_PER_TOKEN) + maxOutputTokens;
}

export function modelStepOutcome(
  answer: { object?: unknown; text: string },
  outputSchema: Record<string, unknown>,
): ModelStepOutcome {
  const value = answer.object ?? null;
  if (value === null) {
    return {
      ok: false,
      failure: {
        code: MODEL_OUTPUT_INVALID,
        message:
          "The model did not answer with a JSON value that matches the step's output_schema.",
        details: { text_excerpt: answer.text.slice(0, 500) },
      },
    };
  }
  const check = checkJsonSchemaContract(value, outputSchema, "output_schema");
  if (!check.ok) {
    return {
      ok: false,
      failure: {
        code: MODEL_OUTPUT_SCHEMA_INVALID,
        message: `The step's output_schema is not a usable JSON Schema: ${check.schema_error}`,
      },
    };
  }
  if (check.valid) return { ok: true, output: value };
  return {
    ok: false,
    failure: {
      code: MODEL_OUTPUT_INVALID,
      message: "The model's answer does not match the step's output_schema.",
      details: { violations: check.violations.slice(0, MAX_REPORTED_VIOLATIONS) },
    },
  };
}
