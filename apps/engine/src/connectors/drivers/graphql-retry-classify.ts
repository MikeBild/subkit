// GraphQL transient-error classification.
//
// Identifies responses that are safe to retry: HTTP-level transient statuses
// (429, 5xx) and logical-error entries whose structured metadata names a
// protocol-level transient CLASS. Structured fields are checked FIRST on each
// error entry; message-substring matching is a last-resort secondary signal
// used only when an entry carries NO structured classification fields at all.
//
// No vendor strings are hardcoded. ThrottlingException from AppSync matches
// THROTTL generically; RATE_LIMITED from Apollo matches RATE_LIMIT; a 503
// from Hasura matches via the HTTP status.

// Protocol-level transient class tokens. Matched case-insensitively as
// substrings of structured fields (extensions.code, errorType, etc.).
const TRANSIENT_CLASSES = [
  "THROTTL", // THROTTLING, THROTTLED, ThrottlingException, …
  "RATE_LIMIT", // RATE_LIMITED, RATE_LIMIT, …
  "RATELIMIT", // RateLimit, ratelimit, …
  "TOO_MANY_REQUESTS",
  "TIMEOUT",
  "UNAVAILABLE",
  "SERVICE_UNAVAILABLE",
  "TRY_AGAIN",
  "TRYAGAIN",
  "INTERNAL", // INTERNAL_SERVER_ERROR, InternalError, …
] as const;

function containsClass(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const upper = value.toUpperCase();
  return TRANSIENT_CLASSES.some((cls) => upper.includes(cls));
}

/**
 * Classify a single error entry for retryability.
 *
 * Rule: if the entry carries ANY structured classification field
 * (extensions.code / errorType / extensions.classification /
 * extensions.http.status), those fields are authoritative. Message-substring
 * matching is only used as a last resort for entries that have no structured
 * classification data at all.
 */
function entryIsRetryable(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  const ext =
    e.extensions && typeof e.extensions === "object"
      ? (e.extensions as Record<string, unknown>)
      : null;

  // Does this entry carry any structured classification field?
  const httpExt =
    ext?.http && typeof ext.http === "object" ? (ext.http as Record<string, unknown>) : null;
  const hasStructured =
    ext?.code !== undefined ||
    e.errorType !== undefined ||
    ext?.classification !== undefined ||
    httpExt !== null;

  if (hasStructured) {
    // Structured fields present — check only those, no message fallback.
    if (containsClass(ext?.code as string | undefined)) return true;
    if (containsClass(e.errorType as string | undefined)) return true;
    if (containsClass(ext?.classification as string | undefined)) return true;
    const httpStatus = httpExt?.status;
    if (typeof httpStatus === "number" && (httpStatus === 429 || httpStatus >= 500)) return true;
    return false;
  }

  // No structured fields — use message substring as last resort.
  return containsClass(e.message as string | undefined);
}

/**
 * Returns true when the response is safe to retry.
 *
 * Retryable conditions (evaluated in order):
 *  1. HTTP status 429 or >= 500 (but not 501 — "not implemented" is permanent).
 *  2. Any error entry in body.errors[] is retryable (see entryIsRetryable).
 */
export function isGraphqlRetryable(status: number, body: unknown): boolean {
  // 501 Not Implemented is permanent — retrying won't change the outcome.
  if (status === 501) return false;
  if (status === 429 || status >= 500) return true;

  const errors = (body as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;

  return errors.some(entryIsRetryable);
}
