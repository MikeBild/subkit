// Per-turn state, output shape, and the loop-breaker constants /
// validation-fingerprint helper. Kept in their own file so the
// wrapping logic in `invoke.ts` and the public registry in the parent
// barrel can share identical types without round-tripping through
// `sdk-wrap.ts`.

import type { ToolResultPause } from "../index.ts";

/** Max tolerated `loop_detected` short-circuits per turn before the outer loop stops. */
export const MAX_TURN_LOOP_WARNINGS = 2;

/**
 * Max consecutive failed tool calls before the wrapper short-circuits
 * with a structured "ask the user" envelope ("no more than 5 failed
 * tool calls in a row").
 */
export const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Max consecutive identical validation-fingerprint failures on the same
 * tool before the wrapper escalates with a structured "stop iterating
 * over this constraint" envelope. Lower than MAX_CONSECUTIVE_FAILURES
 * because identical-fingerprint loops are even less productive than
 * heterogeneous failures — the model is stuck on a structural issue
 * (loop body containment, ${item.…} placement, missing connector
 * binding, etc.) that needs operator input or a different approach.
 */
export const MAX_VALIDATION_FINGERPRINT_REPEAT = 3;

/**
 * Max times a single tool may return the SAME structured `error_code`
 * (or `reason`) in one turn before the wrapper short-circuits with the
 * "ask the user" envelope.
 *
 * The gap this closes: `consecutiveFailures` (MAX_CONSECUTIVE_FAILURES)
 * resets to 0 on the FIRST successful tool call, and
 * `toolValidationFingerprint` only fires on a Zod `errors[]` array. A
 * structured authoring-gate refusal like
 * `transform_authoring_requires_inspect` carries NO `errors[]`, varies
 * its `message`/args every attempt, and is routinely interleaved with
 * successful `inspect_*` / `dry_run_*` reads — so it slips past BOTH
 * existing detectors and can repeat unbounded until pg-boss expires the
 * job (`worker_expired`) after a 30-minute, 240k-token thrash (the
 * publish-ready-essays authoring incident). Counting repeats of the
 * stable `error_code` per tool — not reset by other tools' successes —
 * catches it.
 *
 * Deliberately set BETWEEN `MAX_VALIDATION_FINGERPRINT_REPEAT` (3) and
 * `MAX_CONSECUTIVE_FAILURES` (5). The `error_code` is a COARSE key:
 * legitimate incremental authoring can fail the SAME gate code several
 * times while genuinely converging — e.g. a multi-transform draft where
 * each `dry_run_workflow` records only some upstream shapes (an early
 * step errored, so downstream steps never ran) and `build_workflow`
 * keeps returning `transform_authoring_requires_inspect` with FEWER
 * blocks each round. That is progress, not a loop, and the coarse code
 * can't tell it from thrash — so we give a round more slack than the
 * precise fingerprint cap. Kept strictly BELOW the global
 * consecutive-failures cap (5) so this breaker fires one call earlier
 * than — and stays distinguishable from — the global cap in the
 * no-interleave case; its unique value is the INTERLEAVED-success case
 * the global cap (reset on any success) cannot catch.
 */
export const MAX_ERROR_CODE_REPEAT = 4;

export interface TurnSignals {
  pendingElicitation?: {
    elicitation_id: string;
    tool_name: string;
    kind?: string;
    summary: string;
    input?: unknown;
    diff?: unknown;
    target?: unknown;
  };
  committed?: {
    workflow_id: string;
  };
  /** Tool-call step counter used only for log correlation. */
  step: number;
  /**
   * Per-turn promise-chain mutex. The SDK executes parallel tool calls
   * within a single step via `Promise.all`, but our tools mutate
   * shared draft state (`ctx.setDraft`) and emit events in a strict
   * ordering. Queueing every wrapper's body on this chain keeps
   * draft mutations serial and event order deterministic, at the cost
   * of losing parallel speedup (acceptable — tool bodies are short
   * and almost always DB-bound).
   */
  toolChain: Promise<void>;
  /**
   * Current step's assistant anchor. Created lazily on the first
   * child-row write so tool-only steps still get a stable parent
   * message, then finalized by `onStepFinish`.
   */
  assistantMessageId?: string | null;
  /**
   * Per-step buffer of child rows created by tool wrappers since the
   * last `onStepFinish`. Normal writes already stamp
   * `parent_message_id`; the loop keeps this buffer so its end-of-step
   * back-fill remains an idempotent safety net.
   */
  pendingChildToolCallIds: string[];
  pendingChildElicitationIds: string[];
  /**
   * Loop-breaker: per-turn counter of how many times each tool has
   * been invoked. Read-only tenant tools get a lower cap than draft /
   * write tools because repeated reads burn tokens without changing
   * state. This broke the repeated list_workflows loop observed in
   * session 64e36248 and the older commit/delete loop in 46ee7ec8.
   */
  toolInvocationCount: Map<string, number>;
  toolLastErrorHash: Map<string, string>;
  /**
   * Per-tool consecutive-identical-args streak tracker for the
   * adaptive loop-breaker. A single global step cap that trusts the
   * model is too coarse; plain per-tool
   * counters fire even on legitimate incremental authoring (e.g.
   * propose_step × 5 across a 5-step workflow). Adaptive shape:
   *   - reads / probes: NO per-tool cap (the model needs them)
   *   - writes: cap on consecutive IDENTICAL args, not total calls.
   *     Five propose_step calls with different step ids = fine.
   *     Three propose_step calls with the same args = repair spiral.
   * Map value: { last_args_hash, repeat_count }. Reset when the
   * hash changes.
   */
  toolArgsRepeat: Map<string, { hash: string; count: number }>;
  /**
   * Per-tool consecutive-identical-validation-fingerprint streak. Args
   * may differ across attempts ("propose_step with step.id=A" then
   * "propose_step with step.id=B") yet the engine returns the SAME
   * validation error pattern (e.g. both miss a required `connector_id`).
   * The argsHash tracker above wouldn't fire because each call has
   * unique args. This tracker fingerprints the `errors[]` array — if
   * the SHAPE of failures stays identical across N attempts, the model
   * is hitting the same constraint and needs the user to weigh in.
   *
   * Fingerprint: sorted (path, message-prefix) tuples joined. Reordering
   * within errors[] hashes the same. Different shape → counter resets.
   *
   * Distinct from `toolLastErrorHash` (which records the latest shape
   * for diagnostics) — this one drives the loop break.
   *
   * Pre-fix session f00b8d1c: build_workflow tried 4 different
   * step shapes, each producing the same `unknown loop body target`
   * + `${item.…} placeholder outside loop body` pair. Old loop
   * detector saw 4 distinct argsHashes and never tripped.
   */
  toolValidationFingerprint: Map<string, { hash: string; count: number }>;
  /**
   * Per-tool same-`error_code` streak. Keyed by tool name → the stable
   * error code (`reason` ?? `error_code`) and how many times in a row
   * this tool returned it. Unlike `consecutiveFailures` this is NOT
   * reset by OTHER tools succeeding — only by this tool succeeding or
   * returning a DIFFERENT code — so an authoring-gate refusal that the
   * model keeps re-triggering with fresh args (interleaved with
   * successful reads) is caught at `MAX_ERROR_CODE_REPEAT`. Distinct
   * from `toolValidationFingerprint`, which only tracks Zod `errors[]`
   * shapes; this one tracks the top-level structured `error_code` that
   * gate refusals carry instead of an `errors[]` array.
   */
  toolErrorCodeRepeat: Map<string, { code: string; count: number }>;
  /**
   * Turn-level loop-warning counter. Incremented by the per-tool
   * loop-breaker on every short-circuit. Once this exceeds
   * `MAX_TURN_LOOP_WARNINGS`, the loop's `stopWhen` bails out so the
   * model does not keep getting re-driven into the same short-circuit
   * with nothing but `_loop_detected` artefacts to show for it.
   */
  totalLoopWarnings: number;
  /**
   * Global consecutive-failures counter. Incremented after every tool
   * call that returns `ok: false` regardless of which tool. Reset to 0
   * after the first successful tool call. When it reaches
   * `MAX_CONSECUTIVE_FAILURES`, the next tool call is short-circuited
   * with a structured envelope instructing the model to emit
   * `ask_user_choice` / `ask_user_text` instead of patching further.
   *
   * The "no more than 5 failed tool calls in a row" rule is enforced
   * here. Per-tool caps (toolInvocationCount above)
   * push the model to switch tool but keep looping; this global cap
   * forces a question to the user. Both layers are kept — the per-tool
   * cap protects against pathological retries on a single tool, the
   * global cap protects against an authoring loop that walks
   * (update_param → dry_run_workflow → update_param → dry_run_workflow)
   * without ever succeeding.
   */
  consecutiveFailures: number;
  /**
   * Running snapshot of the most recent assistant text surfaced by
   * `onStepFinish`. Used by the post-run fallback that synthesises a
   * visible message when the turn ended with no text but tool results.
   */
  lastAssistantText: string;
  /**
   * Last SUCCESSFUL execution-shaped tool result of the turn
   * (run_workflow / wf_<slug>), keyed by its args hash. When the loop
   * guard aborts an IDENTICAL re-issued call, the abort envelope attaches
   * this as `prior_success_output` — the run already succeeded; hiding its
   * result behind "no output" was the production A2 failure mode (the
   * loop-abort envelope replaced the success in the fallback summary).
   */
  lastExecutionSuccess: { tool: string; args_hash: string; output: unknown } | null;
}

/**
 * Payload the SDK feeds back to the model as the tool-result. Keeps
 * the existing `{ok, data, ...}` envelope so models already trained on
 * our tool palette see an identical shape.
 */
export interface WrappedToolOutput {
  ok: boolean;
  data: unknown;
  pause?: ToolResultPause;
  committed_workflow_id?: string;
}

/**
 * Reduce an `errors[]` array into a stable fingerprint:
 *   - keep only path + first 60 chars of message
 *   - sort lexicographically so reordering doesn't change the hash
 *   - drop dynamic IDs / UUIDs / numbers from messages so error
 *     messages whose only difference is a UUID still hash the same
 *
 * Returns null when the input is empty or unrecognisable so the caller
 * can skip fingerprint tracking entirely.
 */
export function computeValidationFingerprint(
  errors: Array<{ path?: unknown; message?: unknown }>,
): string | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const tuples: string[] = [];
  for (const e of errors) {
    const path = typeof e.path === "string" ? e.path : "";
    const rawMsg = typeof e.message === "string" ? e.message : "";
    if (!path && !rawMsg) continue;
    // Strip UUID-like tokens and numbers so identical-shape errors
    // that vary only in IDs still hash the same.
    const stripped = rawMsg
      .replace(/\b[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "<uuid>")
      .replace(/\b\d+\b/g, "<n>")
      .slice(0, 60);
    tuples.push(`${path}::${stripped}`);
  }
  if (tuples.length === 0) return null;
  return tuples.sort().join("|");
}
