// Per-step scope envelope helpers + a pure `required`-only JSON-schema
// validator used at the input/output boundaries of the execution
// pipeline. Pure functions only; no DB, no async.

import { isOffloadRef, type OffloadRef, OffloadResolutionError, previewOf } from "../offload.ts";
import type { RunStepOutcome } from "../step-runner.ts";
import type { HeldRequest, StepResult } from "../types.ts";

export function validateAgainstJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
  location: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!schema || typeof schema !== "object") return { valid: true, errors: [] };
  const obj =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const required = schema.required as string[] | undefined;
  if (required && Array.isArray(required) && required.length > 0) {
    // A null / undefined / non-object value cannot satisfy any required
    // field. Report them all rather than silently passing — this is the
    // boundary that turns a misconfigured scheduled run (fired with no
    // input) into a fast, named failure instead of an opaque downstream
    // error six steps later.
    for (const field of required) {
      if (!obj || !(field in obj)) {
        errors.push(`${location}: required field '${field}' is missing`);
      }
    }
  }
  // For each DECLARED property that is actually present, validate its JSON
  // Schema `type` and `enum` membership. `additionalProperties` stays
  // permissive: undeclared keys are ignored, and a declared-but-absent key
  // is the `required` loop's concern, not this one. This restores the
  // type/enum half of the input/output contract — a misconfigured run that
  // passes the wrong scalar type now fails fast and named at the boundary.
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : null;
  if (obj && properties) {
    for (const [field, rawSpec] of Object.entries(properties)) {
      if (!(field in obj)) continue;
      if (!rawSpec || typeof rawSpec !== "object") continue;
      const spec = rawSpec as Record<string, unknown>;
      const fieldValue = obj[field];
      const expectedType = typeof spec.type === "string" ? spec.type : null;
      if (expectedType && !matchesJsonSchemaType(fieldValue, expectedType)) {
        errors.push(`${location}: field '${field}' must be type '${expectedType}'`);
        // Skip the enum check when the type is already wrong — one named
        // error per field is enough to point the operator at the fix.
        continue;
      }
      const enumValues = Array.isArray(spec.enum) ? spec.enum : null;
      if (enumValues && enumValues.length > 0 && !enumValues.includes(fieldValue)) {
        const rendered = enumValues.map((v) => JSON.stringify(v)).join(", ");
        errors.push(`${location}: field '${field}' must be one of [${rendered}]`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/** JSON Schema `type` check for the scalar/structural keywords subkit's
 *  input/output schemas use. `integer` is a `number` with no fractional
 *  part; `object` excludes arrays and null; `array` is a real array. */
function matchesJsonSchemaType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      // Unknown / unsupported type keyword — stay permissive rather than
      // inventing a failure for a contract we don't model.
      return true;
  }
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
  /** Hold-writes preview (Fix G): the step's request was materialized
   *  but NOT dispatched. `data` is null by contract; the artifact rides
   *  `held_request`. Surfaces per-iteration inside loop accumulators so
   *  the preview judge sees every would-be write. */
  held?: true;
  held_request?: HeldRequest;
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

/** What one loop-body envelope contributes to the empty-loop heuristic.
 *  `offloaded` is productive too; it is reported separately only because
 *  the caller counts offloaded iterations for telemetry. */
export type BodyEnvelopeVerdict = "productive" | "offloaded" | "empty";

/**
 * An empty payload means two different things depending on where it came from.
 *
 * A transform that computes `[]` on every iteration is the defect the
 * empty-loop warning exists to catch: the body read the wrong scope and the
 * run "succeeds" with no rows. A request that returns `[]` under a successful
 * status code is a remote system answering the question — "this repository had
 * no referrers in the last 14 days" is a complete answer, and no edit to the
 * step can make it non-empty. Telling an author to repair that step asks for
 * the impossible, and an authoring model asked for the impossible rewrites
 * something that worked.
 *
 * Only the second kind carries a `status_code`: `wrapEnvelope` sets it from
 * the dispatch's `request_meta`, so it is present exactly when the step
 * reached a system outside the engine and that system replied.
 */
export function classifyBodyEnvelope(value: unknown): BodyEnvelopeVerdict {
  const env = value as ScopeEnvelope | null | undefined;
  if (!env || typeof env !== "object") return "empty";
  // Hold-writes preview: a held body step carries no data BY DESIGN (the
  // artifact rides `held_request`), and a sibling skipped for depending on it
  // is equally intentional — neither must trip the heuristic during a hold
  // preview of an all-writes loop body.
  if (env.held) return "productive";
  if (env.error) return env.error.code === "skipped_dependency_held" ? "productive" : "empty";
  // An offloaded payload appears as an `OffloadRef`. It is productive by
  // definition (only oversize payloads offload) — count it without rehydrating.
  if (isOffloadRef(env.data)) return "offloaded";
  if (typeof env.status_code === "number" && env.status_code < 400) return "productive";
  const data = env.data;
  if (data == null) return "empty";
  if (Array.isArray(data) && data.length === 0) return "empty";
  if (typeof data === "object" && Object.keys(data as object).length === 0) return "empty";
  return "productive";
}

/** Did any envelope in this iteration produce something? Mirrors the
 *  per-iteration accumulation both loop drivers need. */
export function classifyBodyIteration(iteration: unknown): {
  productive: boolean;
  offloaded: boolean;
} {
  if (!iteration || typeof iteration !== "object") return { productive: false, offloaded: false };
  let productive = false;
  let offloaded = false;
  for (const value of Object.values(iteration as Record<string, unknown>)) {
    const verdict = classifyBodyEnvelope(value);
    if (verdict === "offloaded") offloaded = true;
    if (verdict !== "empty") productive = true;
  }
  return { productive, offloaded };
}

export function envelopeFor(outcome: { result: StepResult; scope_value: unknown }): ScopeEnvelope {
  const env = wrapEnvelope({
    data: outcome.scope_value,
    duration_ms: outcome.result.duration_ms ?? 0,
    error: outcome.result.error ?? null,
    request_meta: outcome.result.request_meta ?? null,
  });
  if (outcome.result.held) {
    env.held = true;
    if (outcome.result.held_request) env.held_request = outcome.result.held_request;
  }
  return env;
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
    // with a TYPED error rather than fudging a placeholder size that
    // would under-report the payload everywhere the `OffloadRef` flows.
    // `OffloadResolutionError` redacts `storageUri` in `.message` (the
    // raw `s3://<bucket>/<key>` must not leak onto an error surface).
    if (typeof outcome.result_size_bytes !== "number") {
      throw new OffloadResolutionError(storageUri, "missing result_size_bytes");
    }
    const ref: OffloadRef = {
      $offloaded: true,
      storage_uri: storageUri,
      preview: outcome.result_preview ?? previewOf(outcome.scope_value),
      size_bytes: outcome.result_size_bytes,
      ...(outcome.result_sha256 ? { sha256: outcome.result_sha256 } : {}),
    };
    env.data = ref;
  }
  return env;
}
