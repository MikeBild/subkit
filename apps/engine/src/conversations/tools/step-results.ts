// Shared builder for the OPTIONAL `step_results` surface that
// `dry_run_workflow` / `run_workflow` attach when the caller sets
// `include_step_results: true`.
//
// D6 (streamed step results into the model): by default those tools return
// a COMPACT summary — a truncated per-step `step_trace` (and, for a green
// run, no trace at all). That is enough to see WHAT each step produced but
// not enough to self-diagnose WHY: the model cannot tell a step-config bug
// (the request went out wrong) from an output_transform bug (the step was
// fine, the projection dropped the data) without seeing BOTH the resolved
// per-step INPUT and its OUTPUT side-by-side.
//
// `include_step_results` opts into exactly that: one entry per step carrying
//   - `input`  — the resolved request the step actually issued
//                (`request_meta`), or the materialized-but-held request for a
//                write step (`held_request`). This is the "what went in".
//   - `output` — the step's post-selector output. Passed through the SAME
//                offload layer every other LLM-visible preview uses
//                (`truncateStepPreviewForLlm`), so a large payload is capped
//                inline and the FULL value stays fetchable via the returned
//                `output_ref` (`get_raw_result` / `inspect_execution_step`) —
//                no new store.
//   - `raw_output` — the pre-`data_selector` envelope, when the step had a
//                selector, so the model can see what the selector dropped.
//
// This reuses the in-memory `run.steps` the tools already hold plus the
// existing raw-ref machinery; it introduces no new persistence.

import { truncateStepPreviewForLlm } from "./truncate.ts";

/** The subset of a `RunResult` step this builder reads. Structural so it
 *  accepts both `dry_run_workflow`'s and `run_workflow`'s run summaries
 *  without importing the full execution types. */
export interface RawStepResultSource {
  step_key: string;
  kind: string;
  status: string;
  duration_ms?: number | null;
  request_meta?: unknown;
  held?: true;
  held_request?: unknown;
  output_preview?: unknown;
  raw_preview?: unknown;
  error?: unknown;
}

export interface RawStepResult {
  step_id: string;
  kind: string;
  status: string;
  duration_ms?: number | null;
  /** The resolved request the step issued (`request_meta`), or the held
   *  (materialized-but-not-dispatched) request for a write step. Null for
   *  steps that make no request (transform, wait, branch). */
  input: unknown;
  /** Post-selector step output. Inline value is offload-truncated; the full
   *  payload is at `output_ref` via `get_raw_result`. */
  output?: unknown;
  output_ref?: string;
  /** Pre-`data_selector` envelope, when the step had a selector. */
  raw_output?: unknown;
  raw_output_ref?: string;
  error?: unknown;
}

/**
 * Build the per-step raw input/output list. Inputs are compact already
 * (resolved request metadata); outputs flow through the offload layer so a
 * multi-step raw dump stays inside the envelope budget while every full
 * value remains one `get_raw_result` call away.
 */
export function buildRawStepResults(steps: ReadonlyArray<RawStepResultSource>): RawStepResult[] {
  return steps.map((s) => {
    // "What went in" — the resolved request for a request/graphql step, or
    // the held artifact for a write step held during a preview. Steps with
    // neither (transform/wait/branch) report null rather than a fabricated
    // shape.
    const input =
      s.request_meta !== undefined && s.request_meta !== null
        ? s.request_meta
        : s.held_request !== undefined && s.held_request !== null
          ? s.held_request
          : null;
    const outputForLlm =
      s.output_preview !== undefined && s.output_preview !== null
        ? truncateStepPreviewForLlm(s.output_preview)
        : null;
    const rawForLlm =
      s.raw_preview !== undefined && s.raw_preview !== null
        ? truncateStepPreviewForLlm(s.raw_preview)
        : null;
    return {
      step_id: s.step_key,
      kind: s.kind,
      status: s.status,
      ...(s.duration_ms != null ? { duration_ms: s.duration_ms } : {}),
      input,
      ...(outputForLlm
        ? {
            output: outputForLlm.data,
            ...(outputForLlm.raw_ref ? { output_ref: outputForLlm.raw_ref } : {}),
          }
        : {}),
      ...(rawForLlm
        ? {
            raw_output: rawForLlm.data,
            ...(rawForLlm.raw_ref ? { raw_output_ref: rawForLlm.raw_ref } : {}),
          }
        : {}),
      ...(s.error ? { error: s.error } : {}),
    };
  });
}
