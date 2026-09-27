// One line naming what happened in a run, read from the engine's structured
// `outcome` — never inferred from `status` alone, which calls a hold-writes
// preview (nothing written) and a run with a tolerated step failure both
// "succeeded".

import type { components } from "@cli-core/engine-api/openapi.d.ts";

type ExecutionOutcome = components["schemas"]["ExecutionOutcome"];

export function executionOutcomeLine(outcome: ExecutionOutcome | null | undefined): string | null {
  if (!outcome) return null;
  const parts: string[] = [outcome.kind];
  if (outcome.kind === "held") parts.push("— writes held, nothing written");
  if (outcome.failed_step) {
    parts.push(`at step ${outcome.failed_step.step_key} (${outcome.failed_step.kind})`);
  }
  const cause = [outcome.cause_class, outcome.error_code].filter(Boolean).join(", ");
  if (cause) parts.push(`· ${cause}`);
  const s = outcome.steps;
  parts.push(
    `· steps ${s.succeeded}/${s.total} ok` +
      (s.failed ? `, ${s.failed} failed` : "") +
      (s.held ? `, ${s.held} held` : "") +
      (s.skipped ? `, ${s.skipped} skipped` : ""),
  );
  if (outcome.output_contract !== "none")
    parts.push(`· output contract ${outcome.output_contract}`);
  return parts.join(" ");
}
