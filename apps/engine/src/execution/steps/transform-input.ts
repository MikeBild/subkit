import type { TransformStep } from "../../workflows/index.ts";
import { resolveValuePath } from "../selectors.ts";

type TransformInputOutcome = { ok: true; value: unknown } | { ok: false; message: string };

export function transformInputFor(
  step: TransformStep,
  scope: Readonly<Record<string, unknown>>,
  workflowInput: unknown,
): TransformInputOutcome {
  if (step.input_from === undefined) return { ok: true, value: workflowInput };
  const value = resolveValuePath(scope, step.input_from);
  if (value !== undefined) return { ok: true, value };
  return {
    ok: false,
    message: `transform input_from \`${step.input_from}\` resolved to nothing; check the earlier step's output shape (step outputs sit at \`<step_id>.data\`)`,
  };
}
