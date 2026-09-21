// Which declared boundaries did a preview never get to check?
//
// A step is held to the boundary it declares before anything is sent, so a
// green preview vouches for every bounded step it REACHED. A held preview also
// skips every step behind a held write, and a boundary on one of those was
// compared with nothing: a guessed folder there passes every preview and fails
// the first scheduled run after a human approved it. The author has to be told
// which steps those are, and where the real key or URL can be read instead.
//
// Envelope-only, like the inherited-reference notice: it is for this call's
// reader, not a failure to replay next turn.

import type { StepDef } from "../../workflows/types.ts";

export const UNVERIFIED_BOUNDARY_CODE = "boundary_unverified_in_preview";

export interface UnverifiedBoundariesNotice {
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
      // Absent from the run altogether counts too: it was not checked either.
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
