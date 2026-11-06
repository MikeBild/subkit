import type { StepDef } from "../../workflows/types.ts";

const UNVERIFIED_BOUNDARY_CODE = "boundary_unverified_in_preview";

interface UnverifiedBoundariesNotice {
  code: typeof UNVERIFIED_BOUNDARY_CODE;
  message: string;
  step_ids: string[];
}

export function unverifiedBoundaries(
  steps: ReadonlyArray<StepDef>,
  ran: ReadonlyArray<{ step_key: string; status: string }>,
): UnverifiedBoundariesNotice | null {
  const status = new Map(ran.map((entry) => [entry.step_key, entry.status]));
  const step_ids = steps
    .filter((step) => {
      if (step.kind !== "request") return false;
      if (!step.boundary && !step.s3?.scope) return false;
      const outcome = status.get(step.id);
      return outcome === undefined || outcome === "skipped";
    })
    .map((step) => step.id);
  if (step_ids.length === 0) return null;
  return {
    code: UNVERIFIED_BOUNDARY_CODE,
    step_ids,
    message:
      `The preview could not check the boundary on ${step_ids.map((id) => `\`${id}\``).join(", ")}: ` +
      "these steps were skipped, so a green preview says nothing about them. Before handing " +
      "over for approval, compare each one's `s3.scope.key_prefix` and size, or its `boundary`, " +
      "with the key or URL the step really uses — read the transform that builds it, or the " +
      "same step in the last real run (`inspect_execution_step`). A folder or size that does " +
      "not fit fails the first scheduled run.",
  };
}
