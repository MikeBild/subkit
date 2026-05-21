// Per-step scope envelope helpers + a pure `required`-only JSON-schema
// validator used at the input/output boundaries of the execution
// pipeline. Pure functions only; no DB, no async.

import { type OffloadRef, previewOf } from "../offload.ts";
import type { RunStepOutcome } from "../step-runner.ts";
import type { StepResult } from "../types.ts";

export function validateAgainstJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
  location: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!schema || typeof schema !== "object") return { valid: true, errors: [] };
  const required = schema.required as string[] | undefined;
  if (required && Array.isArray(required) && required.length > 0) {
    // A null / undefined / non-object value cannot satisfy any required
    // field. Report them all rather than silently passing — this is the
    // boundary that turns a misconfigured scheduled run (fired with no
    // input) into a fast, named failure instead of an opaque downstream
    // error six steps later.
    const obj =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    for (const field of required) {
      if (!obj || !(field in obj)) {
        errors.push(`${location}: required field '${field}' is missing`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Envelope shape exposed on `scope[step.id]`. Transform expressions
 *  read `$scope.<id>.data` for the payload and `$scope.<id>.status_code`
 *  / `$scope.<id>.headers` / `$scope.<id>.error` / `$scope.<id>.duration_ms`
 *  for diagnostics. Matches the contract documented in the
 *  data-handling skill. */
export interface ScopeEnvelope {
  data: unknown;
  status_code?: number;
  headers?: Record<string, string>;
  duration_ms: number;
  error: { code: string; message: string; details?: unknown } | null;
}

export function wrapEnvelope(params: {
  data: unknown;
  duration_ms: number;
  error: { code: string; message: string; details?: unknown } | null;
  request_meta?: Record<string, unknown> | null;
}): ScopeEnvelope {
  const env: ScopeEnvelope = {
    data: params.data ?? null,
    duration_ms: params.duration_ms,
    error: params.error ?? null,
  };
  const rm = params.request_meta;
  if (rm && typeof rm === "object") {
    if (typeof rm.status === "number") env.status_code = rm.status;
    if (rm.headers && typeof rm.headers === "object") {
      env.headers = rm.headers as Record<string, string>;
    }
  }
  return env;
}

export function envelopeFor(outcome: { result: StepResult; scope_value: unknown }): ScopeEnvelope {
  return wrapEnvelope({
    data: outcome.scope_value,
    duration_ms: outcome.result.duration_ms ?? 0,
    error: outcome.result.error ?? null,
    request_meta: outcome.result.request_meta ?? null,
  });
}

/**
 * Build the per-body-step envelope that accumulates into a loop's
 * `iterationResults` array. `iterationResults` stays resident for the
 * whole run (one entry per iteration), so a body step that produced a
 * multi-MB payload would otherwise pin that payload in memory N times
 * over — the OOM root cause.
 *
 * When the body step's serialized result exceeded `STEP_RESULT_DB_BYTES`
 * AND was therefore already offloaded to durable storage (its
 * `result_storage_uri` is set), the envelope's `data` field is replaced
 * with an in-memory `OffloadRef` pointing at that SAME storage_uri — no
 * second offload write. The small envelope fields (`status_code`,
 * `error`, `duration_ms`, `headers`) stay inline so loop-level checks
 * (productive-iteration detection, warnings) work without re-hydration.
 *
 * Small results pass through verbatim — identical to `envelopeFor`.
 *
 * The resulting envelope is in-memory-only: `engine.ts` resolves every
 * embedded `OffloadRef` back to plain JSON before the loop value is
 * persisted or handed to a validator / selector.
 */
export function bodyEnvelopeForLoopAccumulator(outcome: RunStepOutcome): ScopeEnvelope {
  const env = envelopeFor(outcome);
  const storageUri = outcome.result_storage_uri;
  // Only swap when the step-runner actually offloaded this payload.
  // `result_storage_uri` is `null` for inline (small) results.
  if (storageUri && outcome.scope_value != null) {
    // INVARIANT: the step-runner sets `result_size_bytes` and
    // `result_storage_uri` together (offload write returns both). A
    // storage uri with no size is a broken outcome — fail loudly here
    // rather than fudging a placeholder size that would under-report
    // the payload everywhere the `OffloadRef` flows.
    if (typeof outcome.result_size_bytes !== "number") {
      throw new Error(
        `offload outcome invariant violated: result_storage_uri is set ` +
          `(${storageUri}) but result_size_bytes is missing`,
      );
    }
    const ref: OffloadRef = {
      $offloaded: true,
      storage_uri: storageUri,
      preview: outcome.result_preview ?? previewOf(outcome.scope_value),
      size_bytes: outcome.result_size_bytes,
    };
    env.data = ref;
  }
  return env;
}
