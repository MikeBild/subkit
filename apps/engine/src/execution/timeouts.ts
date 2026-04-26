// Single source of truth for engine-wide numeric limits and budgets.
//
// Everything that bounds work — execution timeouts, sandbox CPU/memory caps,
// payload-spillover thresholds, LLM tool-result truncation budgets,
// repair-attempt caps — lives here so operators have one place to look and
// reviewers have one place to gate.
//
// New constants must:
//   1. carry units in the name (`_MS`, `_BYTES`, `_REQUESTS`, `_ATTEMPTS`),
//   2. include a one-line comment explaining what bites first when the cap
//      is reached (timeout, OOM, retry exhaustion, etc.),
//   3. be referenced by every call site rather than redeclared locally.
//
// `docs/06-execution.md` reproduces this table for operators; keep them
// in sync.

// --- Workflow / step lifetimes ----------------------------------------

/** Hard ceiling for a single workflow run. After this the engine sets
 *  status=`timed_out` and aborts in-flight steps. Six hours covers the
 *  long-running data-sync use case while still bounding pathological
 *  cycles. */
export const WORKFLOW_TIMEOUT_DEFAULT_MS = 6 * 60 * 60_000;

/** Default per-step timeout when the step itself doesn't declare one.
 *  Steps may opt into a tighter budget via `timeout_ms` on the step
 *  config; this is the safety net. */
export const STEP_TIMEOUT_DEFAULT_MS = 60 * 60_000;

/** Default ceiling for `transform` steps (user JS in the QuickJS sandbox).
 *  A transform that takes longer than this is almost certainly looping. */
export const TRANSFORM_TIMEOUT_DEFAULT_MS = 10 * 60_000;

// --- Recursion / pagination guards ------------------------------------

/** How deep `call` steps may nest before the engine refuses to recurse.
 *  Prevents infinite tool-chains. */
export const MAX_CALL_DEPTH = 5;

/** How many times the engine will retry a single transient `request`
 *  step before giving up. pg-boss handles backoff. */
export const MAX_CALL_RETRIES = 5;

/** Hard cap on pagination requests for any single step. Stops a missing
 *  termination condition from drifting into an effectively-infinite loop. */
export const MAX_PAGINATION_REQUESTS = 1_000;

// --- Self-healing -----------------------------------------------------

/** Bounded number of LLM repair attempts the self-healing loop will
 *  make against the same drift signal before marking the patch
 *  candidate as permanently failed. The first attempt gets a clean
 *  `prior_failures` block; every subsequent attempt folds in the
 *  previous rejected proposal so the model can revise instead of
 *  re-emitting the same shape. Two attempts is enough to catch the
 *  common "LLM proposed unsafe patch first" case without burning
 *  budget on pathological drift. */
export const MAX_REPAIR_ATTEMPTS = 2;

// --- Payload spillover (mirrors offload.ts so callers can pull from one
//     file regardless of which side of the boundary they're on) --------

/** Above this size the engine spills the full step payload to object
 *  storage and persists only a `previewOf()` sample inline. Mirrored in
 *  `execution/offload.ts`. */
export const STEP_RESULT_DB_BYTES = 10 * 1024;

/** How many characters of a spilled payload survive inline as a debug
 *  preview. Mirrored in `execution/offload.ts`. */
export const STEP_RESULT_PREVIEW_BYTES = 512;

// --- LLM tool-result truncation ---------------------------------------

/** Maximum characters of a successful tool result that survive into the
 *  LLM's history. Anything larger is sampled (3-level depth) and gains a
 *  `_truncated` marker so the model can ask for a focused subset. */
export const LLM_TOOL_RESULT_SUCCESS_BYTES = 80_000;

/** Same idea, smaller budget for error results. Errors tend to repeat
 *  themselves and rarely need to land verbatim. */
export const LLM_TOOL_RESULT_ERROR_BYTES = 50_000;

/** Maximum number of array entries kept after sampling. Excess entries
 *  are dropped with a `_truncated_count` marker. */
export const LLM_TOOL_RESULT_ARRAY_CAP = 100;

/** Depth at which deep object branches collapse to a typed placeholder
 *  during sampling. */
export const LLM_TOOL_RESULT_SAMPLE_DEPTH = 3;

// --- Sandbox (in-process Wasm) ----------------------------------------
//
// Authoritative defaults live in `apps/engine/src/sandboxes/quickjs/types.ts`
// (`DEFAULT_LIMITS`); the values are reproduced here as constants so
// non-sandbox callers (e.g. self-healing classifier) can reference the
// numbers without importing the sandbox module's types.

/** Hard Wasm heap cap for a single sandbox call. */
export const SANDBOX_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;

/** Wall-clock cap for a sandbox call. Mirrors
 *  `TRANSFORM_TIMEOUT_DEFAULT_MS` for transform steps; isolated here so
 *  before-request hooks can opt into a tighter budget. */
export const SANDBOX_WALL_MS_DEFAULT = 30_000;
