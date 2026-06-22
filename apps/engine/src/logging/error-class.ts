// Coarse error classification for log correlation.
//
// `classifyError` maps an arbitrary thrown value onto one of nine stable
// buckets that operators can facet on (`error_class=upstream_auth`, etc.)
// without reading the raw message. It is a thin router over the
// already-trusted, documented-signal classifiers that live next to each
// subsystem — it adds NO new free-text heuristics of its own:
//
//   - isTransientDbError (db/transient.ts)           → "transient"
//   - classifyPgProbeError (connectors/drivers)      → "upstream_auth" / "resource"
//   - classifyProviderError (llm/provider-errors.ts) → rate_limit/overloaded/timeout/…
//   - HttpError.status (http/errors.ts)              → 4xx/5xx/timeout buckets
//
// Pure + defensive: never throws, handles null / non-Error shapes.

import { classifyPgProbeError } from "../connectors/drivers/probe-classify.ts";
import { isTransientDbError } from "../db/transient.ts";
import { HttpError } from "../http/errors.ts";
import { LlmError } from "../llm/errors.ts";
import { classifyProviderError } from "../llm/provider-errors.ts";

export type ErrorClass =
  | "transient"
  | "upstream_auth"
  | "upstream_4xx"
  | "upstream_5xx"
  | "timeout"
  | "validation"
  | "resource"
  | "logic"
  | "unknown";

/**
 * Classify `err` into one coarse, operator-facetable bucket. The order
 * below is precedence: more specific / higher-signal classifiers win over
 * the generic status-code fallbacks. Every branch routes through an
 * existing classifier — this function never invents a new substring match.
 */
export function classifyError(err: unknown): ErrorClass {
  if (err === null || err === undefined) return "unknown";

  // 1) Transient DB/connectivity bounce — retrying may clear it. Checked
  //    first because a libpq teardown can also carry a SQLSTATE that the
  //    pg-probe classifier would otherwise read as "unknown_upstream".
  if (isTransientDbError(err)) return "transient";

  // 2) PostgreSQL driver errors carry a 5-char SQLSTATE on `.code`. The
  //    probe classifier maps the auth + not-found codes; anything else with
  //    a SQLSTATE is a real query/logic fault, not an upstream blip.
  const pgClass = classifyPgFromSqlstate(err);
  if (pgClass) return pgClass;

  // 3) Typed HTTP errors — bucket by status. Checked BEFORE the provider
  //    classifier: an HttpError carries a `.status` the provider heuristic
  //    would otherwise read as a generic upstream code, mis-bucketing
  //    408/504 as 5xx instead of timeout.
  if (err instanceof HttpError) {
    return mapHttpStatus(err.status);
  }

  // 4) LLM provider errors — reuse the fallback-layer classifier so the
  //    buckets stay aligned with what the retry/fallback path already does.
  if (err instanceof LlmError || looksLikeProviderError(err)) {
    const providerClass = mapProviderError(err);
    if (providerClass) return providerClass;
  }

  // 5) Zod / validation errors surface a `name === "ZodError"` and an
  //    `issues` array. Documented shape — not a substring guess.
  if (looksLikeValidationError(err)) return "validation";

  return "unknown";
}

/**
 * Map a `pg`-style SQLSTATE error. Returns null when the value has no
 * SQLSTATE so the caller can fall through to the next classifier.
 */
function classifyPgFromSqlstate(err: unknown): ErrorClass | null {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  // Only treat 5-char alphanumeric strings as SQLSTATE; Node system codes
  // like ECONNRESET were already handled by isTransientDbError above.
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) return null;
  const probe = classifyPgProbeError(err);
  if (probe === "credential_invalid") return "upstream_auth";
  if (probe === "remote_resource_not_found") return "resource";
  // A SQLSTATE that isn't auth/not-found is a real query fault (constraint
  // violation, syntax error, type mismatch) — a logic error, not an
  // upstream connectivity issue.
  return "logic";
}

/**
 * True when `err` carries the status/message shape `classifyProviderError`
 * reads. Lets a raw provider SDK error (not yet wrapped in LlmError) route
 * through the provider classifier.
 */
function looksLikeProviderError(err: unknown): boolean {
  const e = err as { statusCode?: unknown; status?: unknown } | null | undefined;
  return typeof e?.statusCode === "number" || typeof e?.status === "number";
}

/** Map the LLM provider-error kind onto an ErrorClass. */
function mapProviderError(err: unknown): ErrorClass | null {
  const kind = classifyProviderError(err);
  switch (kind) {
    case "rate_limit":
    case "overloaded":
      // Retryable upstream back-pressure — a 429/529 the caller should
      // back off on, distinct from a 4xx the caller caused.
      return "upstream_5xx";
    case "quota_exhausted":
      return "upstream_auth";
    case "timeout":
      return "timeout";
    case "context_length_exceeded":
      return "validation";
    case "network_5xx":
      return "upstream_5xx";
    default:
      return null;
  }
}

/** Bucket an HTTP status code. */
function mapHttpStatus(status: number): ErrorClass {
  if (status === 408 || status === 504) return "timeout";
  if (status === 401 || status === 403) return "upstream_auth";
  if (status >= 400 && status < 500) return "upstream_4xx";
  if (status >= 500) return "upstream_5xx";
  return "unknown";
}

/**
 * True for Zod errors. `ZodError` sets `name === "ZodError"` and exposes a
 * non-empty `issues` array — both documented, stable fields.
 */
function looksLikeValidationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name !== "ZodError") return false;
  const issues = (err as { issues?: unknown }).issues;
  return Array.isArray(issues);
}
