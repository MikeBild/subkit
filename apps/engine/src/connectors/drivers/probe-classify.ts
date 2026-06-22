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

/**
 * Classify a Redis driver error.
 *
 * The `redis` (node-redis) library surfaces server errors whose message
 * begins with the RESP error token. The RESP protocol prefixes auth errors
 * with the following leading tokens:
 *
 *   WRONGPASS — returned when the password is wrong (Redis ≥ 6 with ACL).
 *   NOAUTH    — returned when authentication is required but no AUTH was sent.
 *
 * We match the leading token (trimStart + startsWith) so we never match a
 * WRONGPASS or NOAUTH that appears mid-message on an unrelated error.
 * Reference: https://redis.io/docs/manual/security/acl/
 */
export function classifyRedisProbeError(err: unknown): ProbeErrorCode {
  const message =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown })?.message === "string"
        ? (err as { message: string }).message
        : null;

  if (message !== null) {
    const trimmed = message.trimStart();
    // RESP leading-token match: WRONGPASS / NOAUTH at the start of the message.
    if (trimmed.startsWith("WRONGPASS") || trimmed.startsWith("NOAUTH")) {
      return "credential_invalid";
    }
  }

  return "unknown_upstream_error";
}

/**
 * Classify an SFTP driver error from ssh2-sftp-client.
 *
 * ssh2 (the underlying SSH library) sets `(err as {level?:string}).level`
 * to `"client-authentication"` when the server rejects the credentials.
 * This is the documented ssh2 error level for auth failures:
 * https://github.com/mscdex/ssh2#authentication-errors
 */
export function classifySftpProbeError(err: unknown): ProbeErrorCode {
  // ssh2 sets .level = "client-authentication" on credential rejection — true
  // when probing the RAW ssh2.Client.
  const level = (err as { level?: string } | null | undefined)?.level;
  if (level === "client-authentication") return "credential_invalid";
  // The driver uses ssh2-sftp-client, whose error wrapper COPIES ONLY `.code`
  // and DROPS `.level` (src/utils.js errorListener). So through the wrapper the
  // only surviving auth signal is ssh2's stable message for credential
  // rejection — match it so a bad key/password isn't mislabeled as a generic
  // upstream error. (Without this, `.level` never reaches us and SFTP auth
  // failures silently classify as unknown_upstream_error.)
  const msg = err instanceof Error ? err.message : "";
  if (/all configured authentication methods failed/i.test(msg)) return "credential_invalid";
  return "unknown_upstream_error";
}

/**
 * Classify an FTP driver error from basic-ftp.
 *
 * basic-ftp parses control-channel replies and attaches `.code` (the
 * 3-digit FTP reply code) to error objects for negative responses.
 * Reply code 530 is "Not logged in" — the standard FTP authentication
 * failure code per RFC 959 §4.2.
 * Reference: https://tools.ietf.org/html/rfc959#section-4.2
 */
export function classifyFtpProbeError(err: unknown): ProbeErrorCode {
  // basic-ftp attaches the FTP reply code as .code on its error objects.
  const code = (err as { code?: number } | null | undefined)?.code;
  // RFC 959: 530 = Not logged in (authentication failure).
  if (code === 530) return "credential_invalid";
  return "unknown_upstream_error";
}

/**
 * Classify an SMB driver error from @marsaud/smb2.
 *
 * The @marsaud/smb2 library surfaces Windows NT status codes as `.code`
 * on thrown errors. STATUS_LOGON_FAILURE is the NT status code for an
 * authentication failure (wrong username / password / domain).
 * Reference: https://docs.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55
 */
export function classifySmbProbeError(err: unknown): ProbeErrorCode {
  // @marsaud/smb2 surfaces NT status codes as .code on error objects.
  // STATUS_LOGON_FAILURE is the canonical credential-rejection status.
  const code = (err as { code?: string } | null | undefined)?.code;
  if (code === "STATUS_LOGON_FAILURE") return "credential_invalid";
  return "unknown_upstream_error";
}

/**
 * Classify an MSSQL driver error from the `mssql` (tedious) package.
 *
 * Tedious surfaces login failures in two ways:
 *   - `(err as {code?:string}).code === "ELOGIN"` — the tedious error
 *     code for a failed login (wrong credentials, account locked, etc.).
 *   - `(err as {number?:number}).number === 18456` — the SQL Server error
 *     number for "Login failed for user" (all auth variants).
 * References:
 *   https://github.com/tediousjs/tedious/blob/master/src/errors.ts
 *   https://docs.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-18456-database-engine-error
 */
export function classifyMssqlProbeError(err: unknown): ProbeErrorCode {
  // tedious ELOGIN code: covers all login-failure categories.
  const code = (err as { code?: string } | null | undefined)?.code;
  if (code === "ELOGIN") return "credential_invalid";

  // SQL Server error 18456: "Login failed for user". Tedious also exposes
  // this as .number on RequestError / ConnectionError objects.
  const number = (err as { number?: number } | null | undefined)?.number;
  if (number === 18456) return "credential_invalid";

  return "unknown_upstream_error";
}
