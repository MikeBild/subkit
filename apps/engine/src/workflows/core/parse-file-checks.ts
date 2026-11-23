import { suggestClosest } from "../levenshtein.ts";
import type { StepDef } from "../types.ts";
import type { ValidationError } from "./validator.ts";

type TransformStep = Extract<StepDef, { kind: "transform" }>;

const RUN_ROOTS = new Set(["$input", "$state"]);
const LOOP_ITEM_ROOT = "$item";

export function parseFileValidationErrors(
  step: TransformStep,
  knownStepIds: ReadonlySet<string>,
  allowForwardRefs: boolean,
): ValidationError[] {
  const source = step.file?.source;
  if (source === undefined) return [];
  const path = `steps.${step.id}.file.source`;
  const head = source.split(".")[0] ?? "";
  if (RUN_ROOTS.has(head)) return [];
  if (head === LOOP_ITEM_ROOT) {
    if (step.for_each !== undefined) return [];
    return [
      {
        path,
        message: `\`${source}\` reads the loop item, but this step has no \`for_each\`. Add \`for_each\` or point \`file.source\` at an earlier step or \`$input\`.`,
      },
    ];
  }
  if (head === step.id) {
    return [
      {
        path,
        message: `\`${source}\` points at this step itself. Point \`file.source\` at an earlier step's output such as \`download.data\` or at \`$input\`.`,
      },
    ];
  }
  if (head.startsWith("$")) {
    return [
      {
        path,
        message: `\`${source}\` starts with the unknown root \`${head}\`. Use \`$input\` or the id of an earlier step.`,
      },
    ];
  }
  if (knownStepIds.has(head) || allowForwardRefs) return [];
  const near = suggestClosest(
    head,
    [...knownStepIds].filter((id) => id !== step.id),
    3,
  );
  return [
    {
      path,
      message: `\`${source}\` references unknown step "${head}"${near.length > 0 ? ` — did you mean: ${near.join(", ")}` : ""}. Point \`file.source\` at an earlier step's output or at \`$input\`.`,
    },
  ];
}
