import { suggestClosest } from "../levenshtein.ts";
import type { StepDef } from "../types.ts";
import type { ValidationError } from "./validator.ts";

type TransformStep = Extract<StepDef, { kind: "transform" }>;

const LOOP_ITEM_ROOT = "$item";

export function transformInputHead(inputFrom: string): string {
  return inputFrom.split(/[.[]/)[0] ?? "";
}

export function transformInputValidationErrors(
  step: TransformStep,
  stepOrder: ReadonlyMap<string, number>,
  allowForwardRefs: boolean,
): ValidationError[] {
  const inputFrom = step.input_from;
  if (inputFrom === undefined) return [];
  const path = `steps.${step.id}.input_from`;
  const head = transformInputHead(inputFrom);
  const refuse = (message: string): ValidationError[] => [{ path, message }];
  if (head === LOOP_ITEM_ROOT) return [];
  if (head === step.id) {
    return refuse(
      `\`${inputFrom}\` points at this step itself. Point \`input_from\` at an earlier step's output such as \`fetch.data\`.`,
    );
  }
  if (head.startsWith("$")) {
    return refuse(
      `\`${inputFrom}\` starts with \`${head}\`. \`input_from\` names an earlier step's output such as \`fetch.data\`, or \`$item\` inside a for_each step; without it the transform already receives the workflow input.`,
    );
  }
  const referencedIndex = stepOrder.get(head);
  const ownIndex = stepOrder.get(step.id) ?? Number.POSITIVE_INFINITY;
  if (referencedIndex !== undefined) {
    if (referencedIndex < ownIndex) return [];
    return refuse(
      `\`${inputFrom}\` references step "${head}", which is declared after this step. Point \`input_from\` at an earlier step's output.`,
    );
  }
  if (allowForwardRefs) return [];
  const near = suggestClosest(
    head,
    [...stepOrder.keys()].filter((id) => id !== step.id),
    3,
  );
  return refuse(
    `\`${inputFrom}\` references unknown step "${head}"${near.length > 0 ? ` — did you mean: ${near.join(", ")}` : ""}. Point \`input_from\` at an earlier step's output such as \`fetch.data\`.`,
  );
}
