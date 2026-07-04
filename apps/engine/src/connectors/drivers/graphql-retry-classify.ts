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

// ---------------------------------------------------------------------------
// Schema-error classification (drift-detector feed).
//
// A GraphQL failure whose errors say "this field/operation does not exist in
// the schema" is not transient and not an auth problem — the vendor changed
// (or never implemented) the contract a committed workflow references. Same
// structured-fields-first discipline as the transient classifier above; the
// class tokens are the documented validation/implementation constants of the
// major servers (graphql-js "GRAPHQL_VALIDATION_FAILED", graphql-java
// "ValidationError"/"FieldUndefined", AppSync errorType, generic
// "NOT_IMPLEMENTED"), with message phrases as the last-resort fallback.

const SCHEMA_ERROR_CLASSES = [
  "VALIDATION", // ValidationError, GRAPHQL_VALIDATION_FAILED, …
  "FIELDUNDEFINED", // graphql-java FieldUndefined
  "FIELD_UNDEFINED",
  "NOT_IMPLEMENTED", // no resolver for the root field
  "UNKNOWN_FIELD",
] as const;

const SCHEMA_ERROR_MESSAGE_PHRASES = [
  "fieldundefined", // "Validation error of type FieldUndefined: …"
  "cannot query field", // graphql-js
  "no resolver", // "[NOT_IMPLEMENTED] no resolver for Query.chargers"
  "not_implemented",
  "not found in type", // Hasura "field 'x' not found in type: 'query_root'"
  "is undefined", // "Field 'chargers' in type 'Query' is undefined"
] as const;

function containsSchemaClass(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const upper = value.toUpperCase();
  return SCHEMA_ERROR_CLASSES.some((cls) => upper.includes(cls));
}

/** Best-effort extraction of the failing root field from a schema-error
 *  message ("Query.chargers", `Field 'chargers' …`, `Cannot query field
 *  "chargers" …`). Null when no pattern matches. */
function rootFieldFromMessage(message: string): string | null {
  const qualified = message.match(/\b(?:Query|Mutation|Subscription)\.([A-Za-z_][A-Za-z0-9_]*)/);
  if (qualified?.[1]) return qualified[1];
  const singleQuoted = message.match(/[Ff]ield '([A-Za-z_][A-Za-z0-9_]*)'/);
  if (singleQuoted?.[1]) return singleQuoted[1];
  const doubleQuoted = message.match(/[Cc]annot query field "([A-Za-z_][A-Za-z0-9_]*)"/);
  if (doubleQuoted?.[1]) return doubleQuoted[1];
  return null;
}

export interface GraphqlSchemaErrorVerdict {
  schema_shaped: boolean;
  /** Failing root field when it could be parsed (e.g. "chargers"). */
  root_field: string | null;
}

/**
 * Classify a failed GraphQL response body: do its errors declare a SCHEMA
 * mismatch (removed/never-implemented field) rather than a transient or
 * auth failure? Transient entries never count — a throttled request is not
 * drift no matter what its message contains.
 */
export function classifyGraphqlSchemaError(body: unknown): GraphqlSchemaErrorVerdict {
  const errors = (body as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return { schema_shaped: false, root_field: null };
  }
  let schemaShaped = false;
  let rootField: string | null = null;
  for (const entry of errors) {
    if (!entry || typeof entry !== "object") continue;
    if (entryIsRetryable(entry)) continue; // transient beats schema
    const e = entry as Record<string, unknown>;
    const ext =
      e.extensions && typeof e.extensions === "object"
        ? (e.extensions as Record<string, unknown>)
        : null;
    const message = typeof e.message === "string" ? e.message : "";
    const structuredHit =
      containsSchemaClass(ext?.code as string | undefined) ||
      containsSchemaClass(e.errorType as string | undefined) ||
      containsSchemaClass(ext?.classification as string | undefined);
    const messageHit =
      !structuredHit && SCHEMA_ERROR_MESSAGE_PHRASES.some((p) => message.toLowerCase().includes(p));
    if (structuredHit || messageHit) {
      schemaShaped = true;
      rootField ??= rootFieldFromMessage(message);
    }
  }
  return { schema_shaped: schemaShaped, root_field: rootField };
}
