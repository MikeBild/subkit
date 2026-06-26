// Pure per-driver probe classifiers.
//
// Each function maps a driver-specific error shape onto the shared
// ProbeErrorCode vocabulary. Only documented protocol / library constants
// are matched — never free-text substrings. The default is always
// "unknown_upstream_error" to avoid misclassifying transient failures as
// dead credentials.

import type { ProbeErrorCode } from "./index.ts";

/**
 * Classify a GraphQL probe result from HTTP status and any GraphQL-level
 * error messages.
 *
 * - Non-2xx 401/403 → credential_invalid (HTTP auth rejection).
 * - 404 → remote_resource_not_found (the GraphQL endpoint path is wrong —
 *   e.g. Supabase GraphQL lives at /graphql/v1, not /graphql). This steers
 *   the authoring LLM toward fixing base_url instead of treating it as a
 *   transient upstream blip.
 * - 2xx + error messages that name an auth failure (GraphQL 200+errors
 *   pattern, common in AppSync / Hasura / GraphQL-shield) → credential_invalid.
 * - Anything else → unknown_upstream_error.
 */
export function classifyGraphqlProbe(
  status: number,
  errorMessages: string[] | null,
): ProbeErrorCode {
  // HTTP-level auth rejection: the server rejected the credential before
  // executing the query.
  if (status === 401 || status === 403) return "credential_invalid";

  // 404: the endpoint path is wrong, not a credential or transient failure.
  // Mirrors classifyPgProbeError (3D000) and classifyS3ProbeError (404).
  if (status === 404) return "remote_resource_not_found";

  // GraphQL-over-HTTP convention: logical errors ride as HTTP 200 with a
  // top-level `errors` array. AppSync, Hasura, Apollo, and graphql-shield use
  // the phrases below to signal unauthenticated / unauthorised callers.
  // PRECISE phrases only — NOT the bare token "authentication", which would
  // false-flag a schema/validation error like "field authentication_method not
  // found" and trip a healthy connector into needs_reauth. Case-insensitive.
  if (status >= 200 && status < 300 && errorMessages !== null && errorMessages.length > 0) {
    const AUTH_TOKENS = [
      "unauthenticated",
      "unauthorized",
      "not authorized",
      "not authenticated",
      "access denied",
      "permission denied",
      "authentication required",
      "authentication failed",
      "invalid token",
      "token expired",
      "forbidden",
    ];
    const lower = errorMessages.map((m) => m.toLowerCase());
    if (lower.some((m) => AUTH_TOKENS.some((tok) => m.includes(tok)))) {
      return "credential_invalid";
    }
  }

  return "unknown_upstream_error";
}

/**
 * Classify a PostgreSQL driver error by SQLSTATE code.
 *
 * SQLSTATE codes are defined in the PostgreSQL documentation
 * (https://www.postgresql.org/docs/current/errcodes-appendix.html) and
 * surfaced by the `pg` driver as `(err as {code?:string}).code`.
 *
 *   28P01  invalid_password
 *   28000  invalid_authorization_specification (covers LDAP/GSSAPI/cert rejections)
 *   3D000  invalid_catalog_name (database does not exist)
 */
export function classifyPgProbeError(err: unknown): ProbeErrorCode {
  // `pg` attaches the 5-char SQLSTATE as `.code` on its error objects.
  const code = (err as { code?: string } | null | undefined)?.code;
  if (code === "28P01" || code === "28000") return "credential_invalid";
  if (code === "3D000") return "remote_resource_not_found";
  return "unknown_upstream_error";
}

/**
 * Classify an S3 driver error from the @bradenmacdonald/s3-lite-client library.
 *
 * The library throws `ServerError` (errors.ts) for all server-side failures.
 * `ServerError` exposes:
 *   - `statusCode: number` — the HTTP status (401, 403, 404, …)
 *   - `code: string`       — the S3 XML error code (e.g. "InvalidAccessKeyId")
 *
 * Canonical S3 error codes are documented at:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/ErrorResponses.html
 */
export function classifyS3ProbeError(err: unknown): ProbeErrorCode {
  const e = err as { statusCode?: number; code?: string } | null | undefined;

  // statusCode is the primary signal (present on ServerError).
  if (typeof e?.statusCode === "number") {
    if (e.statusCode === 401 || e.statusCode === 403) return "credential_invalid";
    if (e.statusCode === 404) return "remote_resource_not_found";
    return "unknown_upstream_error";
  }

  // Fallback: named error codes from the S3 XML error body (also on ServerError.code).
  // These codes are documented in the S3 API reference.
  if (typeof e?.code === "string") {
    if (
      e.code === "InvalidAccessKeyId" ||
      e.code === "SignatureDoesNotMatch" ||
      e.code === "AccessDenied"
    ) {
      return "credential_invalid";
    }
    if (e.code === "NoSuchBucket") return "remote_resource_not_found";
  }

  return "unknown_upstream_error";
}
