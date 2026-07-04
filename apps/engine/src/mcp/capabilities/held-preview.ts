// Honest hold-writes preview envelope for wf_<slug> MCP results.
//
// The default `wf_*` run holds writes (no `execute_writes`). When a write
// step is held — or a step is skipped behind a held write — the run still
// reports `succeeded` and `result.output` carries whatever upstream
// read/transform last produced. Returned bare, that is indistinguishable
// from a real write: the "gemeldet ≠ geschrieben" no-op (a search-over-POST
// held → the whole write chain skipped → the caller saw the converted
// payload and reported success while nothing was written).
//
// The engine signals this with a mandatory `held_preview_no_writes`
// warning. This pure helper lifts that into a first-class `preview`
// envelope + an `_meta.subkit.execution.preview` flag so the model cannot
// mistake a preview for a real write. Step ids + method/url only — the
// (already-redacted) held bodies never ride along.

import type { RunResult } from "../../execution/types.ts";

const HELD_PREVIEW_WARNING_CODE = "held_preview_no_writes";

export interface ResultEnvelope {
  /** True when the run was a held-writes preview (nothing persisted). */
  isHeldPreview: boolean;
  /** The held-preview warning message — for offload summary lines. */
  heldMessage: string | null;
  /** The body to serialize into the MCP text content block. */
  rawBody: unknown;
  /** Spread into the tool result: `{}` or `{ _meta: { subkit: … } }`. */
  previewMeta: Record<string, unknown>;
}

/**
 * Shape the MCP result envelope for a completed wf_<slug> run. Honors the
 * pre-existing warnings-wrapping contract (wrap output + warnings when any
 * warning is present; bare output when clean) and adds the held-preview
 * envelope + `_meta` on top when the run held writes.
 */
export function buildResultEnvelope(
  result: Pick<RunResult, "warnings" | "output" | "execution_id" | "status">,
): ResultEnvelope {
  const hasWarnings = (result.warnings?.length ?? 0) > 0;
  const heldPreview = result.warnings?.find((w) => w.code === HELD_PREVIEW_WARNING_CODE);
  if (!heldPreview) {
    return {
      isHeldPreview: false,
      heldMessage: null,
      rawBody: hasWarnings
        ? { output: result.output ?? null, warnings: result.warnings }
        : (result.output ?? null),
      previewMeta: {},
    };
  }
  const details = (heldPreview.details ?? {}) as { held_steps?: unknown; would_write?: unknown };
  const heldSteps = Array.isArray(details.held_steps) ? details.held_steps : [];
  const wouldWrite = Array.isArray(details.would_write) ? details.would_write : [];
  return {
    isHeldPreview: true,
    heldMessage: heldPreview.message ?? null,
    rawBody: {
      preview: true,
      writes_held: true,
      message: heldPreview.message,
      // Name the concrete remedy so the model (and both ChatGPT/claude.ai,
      // which looped here) stops re-running the same held preview: a POST is
      // classified as a write by default, so a render/search step gets held
      // and its dependents are skipped. Tell the caller how to resolve it.
      remedy:
        "Held steps are POST/write by default, so each one is held in preview and its " +
        "dependents are skipped. If a held step only READS (e.g. a render or search endpoint), " +
        'set `side_effects: "read"` on that step so it runs in preview and downstream steps are ' +
        "not skipped. To actually perform the writes, re-run with `execute_writes: true`.",
      held_steps: heldSteps,
      would_write: wouldWrite,
      output: result.output ?? null,
      warnings: result.warnings,
    },
    previewMeta: {
      _meta: {
        subkit: {
          execution: {
            id: result.execution_id,
            status: result.status,
            preview: true,
            writes_held: true,
            held_steps: heldSteps,
          },
        },
      },
    },
  };
}
