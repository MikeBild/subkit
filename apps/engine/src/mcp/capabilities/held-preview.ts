// Warnings-wrapping envelope for wf_<slug> MCP results.
//
// A client annotation dialog is not a server-verifiable authority. Held
// preparation must never be presented as successful live execution.
//
// What remains is the warnings-wrapping contract: when a run produced non-fatal
// warnings (e.g. a jsonata `unresolved_identifier`), the output is wrapped so
// the MCP client sees them alongside the payload; a clean run returns the bare
// output.

import { HELD_PREVIEW_WARNING_CODE, type RunResult } from "../../execution/index.ts";

export interface ResultEnvelope {
  /** The body to serialize into the MCP text content block. */
  rawBody: unknown;
  held: boolean;
}

/**
 * Shape the MCP result envelope for a completed wf_<slug> run: wrap
 * `{ output, warnings }` when any warning is present, bare output when clean.
 */
export function buildResultEnvelope(
  result: Pick<RunResult, "warnings" | "output" | "execution_id">,
): ResultEnvelope {
  const held =
    result.warnings?.some((warning) => warning.code === HELD_PREVIEW_WARNING_CODE) ?? false;
  if (held)
    return {
      held: true,
      rawBody: {
        status: "preparation",
        execution_id: result.execution_id,
        live_execution_authorized: false,
        message:
          "External effects were held. Review the exact workflow version and grant a finite execution authority in the workflow cockpit before requesting live runs. Unknown or dynamic effects still require concrete-run review.",
        output: result.output ?? null,
        warnings: result.warnings,
      },
    };
  const hasWarnings = (result.warnings?.length ?? 0) > 0;
  return {
    held: false,
    rawBody: hasWarnings
      ? { output: result.output ?? null, warnings: result.warnings }
      : (result.output ?? null),
  };
}
