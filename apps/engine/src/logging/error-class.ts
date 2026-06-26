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
//   - fetch/socket/TLS names + codes (Web/Node/Bun)  → timeout/transient/upstream_tls
//
// The network/TLS code tables are grounded in primary-source research so the
// picture is complete across BOTH runtimes the code runs under — Bun (the
// production binary) and Node/undici (some paths, and the `.cause` fetch wraps):
//   - Bun fetch error codes: ConnectionRefused / ConnectionClosed /
//     FailedToOpenSocket / UnknownHostName (oven-sh/bun issues #4988/#5363/
//     #3327/#660), TLS surfaces OpenSSL codes (#6520).
//   - undici error codes: UND_ERR_* (nodejs/undici docs/api/Errors.md).
//   - POSIX socket/DNS errno: ECONN*/ENOTFOUND/EAI_AGAIN/EHOSTUNREACH/…
//     (nodejs.org/api/errors.html — Common system errors).
//   - AbortSignal.timeout → DOMException "TimeoutError", abort() → "AbortError"
//     (MDN AbortSignal; note Chromium emitted "AbortError" for timeouts, so we
//     bucket BOTH names as timeout).
//   - OpenSSL X.509 verify codes: CERT_HAS_EXPIRED / DEPTH_ZERO_SELF_SIGNED_CERT
//     / UNABLE_TO_VERIFY_LEAF_SIGNATURE / … (nodejs.org/api/tls.html).
//
// Pure + defensive: never throws, handles null / non-Error shapes. Unwraps the
// `.cause` chain (the documented `fetch` shape — a `TypeError: fetch failed`
// carries the real socket/TLS error on `.cause`).

import { classifyPgProbeError } from "../connectors/drivers/probe-classify.ts";
import { isTransientDbError } from "../db/transient.ts";
import { HttpError } from "../http/errors.ts";
import { LlmError } from "../llm/errors.ts";
import { classifyProviderError } from "../llm/provider-errors.ts";

export type ErrorClass =
  | "transient"
  | "upstream_auth"
  | "upstream_tls"
  | "upstream_4xx"
  | "upstream_5xx"
  | "timeout"
  | "validation"
  | "resource"
  | "logic"
  | "unknown";

/**
 * Classify `err` into one coarse, operator-facetable bucket.
 *
 * Walks up to a few `.cause` links before giving up: `fetch` rejects with a
 * `TypeError: fetch failed` whose real signal (the socket errno) lives on
 * `.cause`, and `new Error(msg, { cause })` chains can nest deeper. The first
 * link that classifies to something specific wins; we stop at a small depth
 * and on a self-referential cause so a cycle can't loop.
 */
export function classifyError(err: unknown): ErrorClass {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur !== null && cur !== undefined; depth++) {
    const cls = classifyDirect(cur);
    if (cls !== "unknown") return cls;
    const next = (cur as { cause?: unknown }).cause;
    if (next === cur) break;
    cur = next;
  }
  return "unknown";
}

/**
 * Classify a single error value (no cause walk). The order below is
 * precedence: more specific / higher-signal classifiers win over the generic
 * status-code fallbacks. Every branch routes through an existing classifier or
 * a documented Web/Node error shape — this function never invents a new
 * substring match.
 */
function classifyDirect(err: unknown): ErrorClass {
  if (err === null || err === undefined) return "unknown";

  // 1) Transient DB/connectivity bounce — retrying may clear it. Checked
  //    first because a libpq teardown can also carry a SQLSTATE that the
  //    pg-probe classifier would otherwise read as "unknown_upstream".
  if (isTransientDbError(err)) return "transient";

  // 2) Network-layer (fetch/socket) failures — request deadline or an
  //    unreachable upstream, by documented Web/Node error name + errno. This
  //    is what a connector HTTP driver throws (the fetch itself, not an HTTP
  //    status); without it those surface as the useless "unknown".
  const netClass = classifyNetworkError(err);
  if (netClass) return netClass;

  // 3) PostgreSQL driver errors carry a 5-char SQLSTATE on `.code`. The
  //    probe classifier maps the auth + not-found codes; anything else with
  //    a SQLSTATE is a real query/logic fault, not an upstream blip.
  const pgClass = classifyPgFromSqlstate(err);
  if (pgClass) return pgClass;

  // 5) Typed HTTP errors — bucket by status. Checked BEFORE the provider
  //    classifier: an HttpError carries a `.status` the provider heuristic
  //    would otherwise read as a generic upstream code, mis-bucketing
  //    408/504 as 5xx instead of timeout.
  if (err instanceof HttpError) {
    return mapHttpStatus(err.status);
  }

  // 6) LLM provider errors — reuse the fallback-layer classifier so the
  //    buckets stay aligned with what the retry/fallback path already does.
  if (err instanceof LlmError || looksLikeProviderError(err)) {
    const providerClass = mapProviderError(err);
    if (providerClass) return providerClass;
  }

  // 7) Zod / validation errors surface a `name === "ZodError"` and an
  //    `issues` array. Documented shape — not a substring guess.
  if (looksLikeValidationError(err)) return "validation";

  return "unknown";
}

// Abort / request-deadline error NAMES. `AbortSignal.timeout()` aborts with a
// DOMException `name === "TimeoutError"`; a manual `AbortController.abort()`
// gives "AbortError" (the only aborts the connector/HTTP layers issue are
// deadlines, so both bucket as a timeout).
const NETWORK_TIMEOUT_NAMES = new Set<string>(["TimeoutError", "AbortError"]);

// Request-deadline codes: undici read/connect timeouts + its abort codes (an
// undici-surfaced AbortSignal.timeout / abort). Source: undici Errors.md.
const NETWORK_TIMEOUT_CODES = new Set<string>([
  "UND_ERR_CONNECT_TIMEOUT", // connect establishment timed out
  "UND_ERR_HEADERS_TIMEOUT", // response headers timed out
  "UND_ERR_BODY_TIMEOUT", // response body read timed out
  "UND_ERR_ABORTED", // request aborted via AbortSignal
  "UND_ERR_ABORT",
]);

// Connectivity codes that mean "could not reach the upstream" — retrying may
// clear them, so they bucket as "transient" alongside the DB-teardown codes.
// Deliberately EXCLUDES the codes `isTransientDbError` already owns
// (ECONNREFUSED / ECONNRESET / ETIMEDOUT / EPIPE) — those are handled first.
// Note ETIMEDOUT (an OS socket-level timeout) is therefore classed "transient",
// NOT "timeout": the "timeout" bucket is reserved for the REQUEST's own
// deadline elapsing (AbortSignal.timeout / undici read timeouts), keeping the
// transient↔timeout boundary consistent (socket-layer vs request-layer).
//
// The engine ships as a Bun-compiled binary, so in production a connector
// `fetch` throws Bun's OWN error codes, NOT POSIX errno or undici codes: a
// refused host → "ConnectionRefused", an unresolvable host → "UnknownHostName",
// a mid-flight close → "ConnectionClosed", a pre-connect failure →
// "FailedToOpenSocket" (sources: oven-sh/bun). A timeout is `name:
// "TimeoutError"`, an abort `name: "AbortError"` — both caught by name above.
// The POSIX / undici codes are kept too so the classifier is correct under a
// Node runtime / for the error `fetch` wraps on `.cause`.
const NETWORK_CONNECTIVITY_CODES = new Set<string>([
  // Bun fetch (production runtime)
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "UnknownHostName", // Bun DNS: host could not be resolved
  // POSIX / undici (Node runtime, or carried on a wrapped `.cause`)
  "ENOTFOUND", // DNS: host not found
  "EAI_AGAIN", // DNS: temporary resolution failure
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "EHOSTDOWN",
  "ECONNABORTED",
  "UND_ERR_SOCKET", // undici: socket closed mid-flight
]);

// TLS / X.509 certificate verification failures. These are a DISTINCT class
// with a distinct remediation (renew/trust the upstream's certificate) — NOT a
// retryable bounce ("transient"), NOT our-credentials being rejected
// ("upstream_auth"), and there is no HTTP response to bucket. The full OpenSSL
// X509_V_ERR_* set is documented in Node's tls.html; these are the ones a
// connector realistically hits (Bun surfaces the same OpenSSL codes on `.code`,
// e.g. oven-sh/bun#6520 UNABLE_TO_GET_ISSUER_CERT).
const TLS_CERT_CODES = new Set<string>([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_CHAIN_TOO_LONG",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_CRL",
  "INVALID_CA",
  "HOSTNAME_MISMATCH",
  // Node-specific TLS wrappers
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  // undici proxy TLS
  "UND_ERR_PRX_TLS",
]);

/**
 * Map a fetch/socket/TLS-level failure to "timeout" (request deadline),
 * "transient" (unreachable upstream), or "upstream_tls" (cert/handshake).
 * Returns null when the shape isn't a recognized network error so the caller
 * falls through. Reads only documented Web/Node fields (`.name`, `.code`) — no
 * message scanning.
 */
function classifyNetworkError(err: unknown): ErrorClass | null {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  if (typeof name === "string" && NETWORK_TIMEOUT_NAMES.has(name)) return "timeout";

  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") {
    if (NETWORK_TIMEOUT_CODES.has(code)) return "timeout";
    if (TLS_CERT_CODES.has(code)) return "upstream_tls";
    if (NETWORK_CONNECTIVITY_CODES.has(code)) return "transient";
  }
  return null;
}

/**
 * Map a `pg`-style SQLSTATE error (`err.code` = the 5-char SQLSTATE; confirmed
 * via pg-protocol parser.ts). Returns null when there's no SQLSTATE so the
 * caller falls through. Dispatches by the documented SQLSTATE CLASS
 * (PostgreSQL Appendix A) rather than collapsing everything non-auth to
 * "logic" — several classes are NOT query bugs:
 *   40001 serialization_failure / 40P01 deadlock_detected → RETRYABLE → transient
 *   53xxx insufficient_resources, 54xxx program_limit         → resource
 *   57014 query_canceled (statement_timeout)                  → timeout
 *   42501 insufficient_privilege                              → upstream_auth
 *   22xxx data_exception                                      → validation
 *   08xxx connection_exception (08004/08007/08P01 etc.)       → transient
 * Genuine query faults (23 constraint, 42 syntax, …) remain "logic".
 */
function classifyPgFromSqlstate(err: unknown): ErrorClass | null {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  // Only treat 5-char alphanumeric strings as SQLSTATE; Node system codes
  // like ECONNRESET were already handled by isTransientDbError above.
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) return null;

  const probe = classifyPgProbeError(err);
  if (probe === "credential_invalid") return "upstream_auth";
  if (probe === "remote_resource_not_found") return "resource";

  // Exact codes that don't follow their class default.
  if (code === "40001" || code === "40P01") return "transient"; // retryable contention
  if (code === "57014") return "timeout"; // query_canceled / statement_timeout
  if (code === "42501") return "upstream_auth"; // insufficient_privilege

  // Class-prefix dispatch (the 2-char SQLSTATE class).
  switch (code.slice(0, 2)) {
    case "08": // connection_exception (08004/08007/08P01 not in the retry set)
    case "40": // transaction_rollback — retryable
      return "transient";
    case "28": // invalid_authorization_specification
      return "upstream_auth";
    case "53": // insufficient_resources (too_many_connections, out_of_memory, disk_full)
    case "54": // program_limit_exceeded
    case "3D": // invalid_catalog_name (handled above too)
      return "resource";
    case "22": // data_exception (out_of_range, invalid_text_representation)
      return "validation";
    default:
      // Genuine query fault (23 integrity constraint, 42 syntax, …).
      return "logic";
  }
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
