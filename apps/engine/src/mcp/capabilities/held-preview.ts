// Warnings-wrapping envelope for wf_<slug> MCP results.
//
// A `wf_*` run executes its writes directly: the human already approved it via
// the client's native `destructiveHint` dialog before the call reached the
// engine (see `tools/policy.ts` — the MCP surface takes no server-side confirm,
// and `mcp/capabilities/tool-meta.ts` for why every write advertises
// `destructiveHint:true`). There is no held-writes preview and no approval
// portal on this path anymore.
//
// What remains is the warnings-wrapping contract: when a run produced non-fatal
// warnings (e.g. a jsonata `unresolved_identifier`), the output is wrapped so
// the MCP client sees them alongside the payload; a clean run returns the bare
// output.

import type { RunResult } from "../../execution/types.ts";

export interface ResultEnvelope {
  /** The body to serialize into the MCP text content block. */
  rawBody: unknown;
}

/**
 * Shape the MCP result envelope for a completed wf_<slug> run: wrap
 * `{ output, warnings }` when any warning is present, bare output when clean.
 */
export function buildResultEnvelope(
  result: Pick<RunResult, "warnings" | "output">,
): ResultEnvelope {
  const hasWarnings = (result.warnings?.length ?? 0) > 0;
  return {
    rawBody: hasWarnings
      ? { output: result.output ?? null, warnings: result.warnings }
      : (result.output ?? null),
  };
}
