// Per-step scope envelope helpers + a pure `required`-only JSON-schema
// validator used at the input/output boundaries of the execution
// pipeline. Pure functions only; no DB, no async.

import type { StepResult } from "../types.ts";

export function validateAgainstJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
  location: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!schema || typeof schema !== "object") return { valid: true, errors: [] };
  const required = schema.required as string[] | undefined;
  if (required && Array.isArray(required) && typeof value === "object" && value !== null) {
    for (const field of required) {
      if (!(field in (value as Record<string, unknown>))) {
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
