import type { ModelStep } from "../types.ts";
import { type PlaceholderKind, parsePlaceholders } from "./placeholder-parser.ts";
import { walkStrings } from "./walk-strings.ts";

export const MODEL_STEP_SECRET_PLACEHOLDER = "model_step_secret_placeholder";

export const MODEL_STEP_DATA_PLACEHOLDERS: ReadonlySet<PlaceholderKind> = new Set([
  "input",
  "caller",
  "scope",
  "item",
  "state",
]);

const SECRET_PLACEHOLDER_MESSAGE =
  "A model step cannot use credentials, secrets or connector settings: they would be sent to the model provider. Use input, scope, item, state or caller values only.";

export interface ModelStepPlaceholder {
  field: string;
  kind: string;
  token: string;
  path: string;
}

export interface ModelStepRefusal {
  code: string;
  message: string;
  details: { refused: Array<{ field: string; token: string }> };
}

export interface ModelStepValidationError {
  path: string;
  message: string;
}

function dataPath(kind: string, stepId: string | undefined, path: readonly string[]): string {
  return [kind, ...(stepId ? [stepId] : []), ...path].join(".");
}

export function modelStepPlaceholders(
  step: Pick<ModelStep, "prompt" | "system" | "input">,
): ModelStepPlaceholder[] {
  const found: ModelStepPlaceholder[] = [];
  walkStrings({ prompt: step.prompt, system: step.system, input: step.input }, (text, path) => {
    for (const token of parsePlaceholders(text).tokens)
      found.push({
        field: path.slice(1),
        kind: token.kind,
        token: token.raw,
        path: dataPath(token.kind, token.stepId, token.path),
      });
  });
  return found;
}

export function modelStepPlaceholderRefusal(
  placeholders: ReadonlyArray<Pick<ModelStepPlaceholder, "field" | "kind" | "token">>,
): ModelStepRefusal | null {
  const refused = placeholders
    .filter((placeholder) => !MODEL_STEP_DATA_PLACEHOLDERS.has(placeholder.kind as PlaceholderKind))
    .map(({ field, token }) => ({ field, token }));
  if (refused.length === 0) return null;
  return {
    code: MODEL_STEP_SECRET_PLACEHOLDER,
    message: SECRET_PLACEHOLDER_MESSAGE,
    details: { refused },
  };
}

export type CompileJsonSchema = (
  schema: Record<string, unknown>,
) => { ok: true } | { ok: false; error: string };

export function modelStepValidationErrors(
  step: ModelStep,
  compileSchema: CompileJsonSchema,
): ModelStepValidationError[] {
  const errors: ModelStepValidationError[] = [];
  const compiled = compileSchema(step.output_schema);
  if (!compiled.ok)
    errors.push({
      path: `steps.${step.id}.output_schema`,
      message: `output_schema is not a valid JSON Schema: ${compiled.error}`,
    });
  const refusal = modelStepPlaceholderRefusal(modelStepPlaceholders(step));
  for (const { field, token } of refusal?.details.refused ?? [])
    errors.push({
      path: `steps.${step.id}.${field}`,
      message: `${token}: ${SECRET_PLACEHOLDER_MESSAGE}`,
    });
  return errors;
}
