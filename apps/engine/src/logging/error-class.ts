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

  // 4) SQL Server (tedious/node-mssql) connection-level codes — the mssql
  //    driver logs these via errorFields, so without this they'd be "unknown".
  const mssqlClass = classifyMssqlError(err);
  if (mssqlClass) return mssqlClass;

  // 4b) File-share drivers: SMB NTSTATUS codes + the SFTP-wrapper codes, and
  //     basic-ftp's numeric FTP reply codes. All keyed on `.code` (or, for ftp,
  //     `.name === "FTPError"` + numeric `.code`).
  const fileShareClass = classifyFileShareError(err) ?? classifyFtpError(err);
  if (fileShareClass) return fileShareClass;

  // 4c) node-redis: client error classes (by constructor name) + server reply
  //     errors (by RESP protocol token). These set no `.code`/`.name`.
  const redisClass = classifyRedisError(err);
  if (redisClass) return redisClass;

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

// SQL Server error codes on `.code`. Sources: tediousjs/tedious (connection.js
// throw sites — ELOGIN/ETIMEOUT/ESOCKET/ECANCEL/EINSTLOOKUP/EENCRYPT/EFEDAUTH)
// and the node-mssql wrapper (mssql/lib/base/*.js — ECONNCLOSED/ENOTOPEN/
// ENOCONN/EALREADY*). Note `ETIMEOUT` (no "D") is the driver's own code,
// distinct from POSIX `ETIMEDOUT`. The lifecycle codes (ECONNCLOSED/ENOTOPEN/
// ENOCONN/EALREADY*) are DETERMINISTIC client misuse — a closed/not-yet-open
// pool — so they are "logic", NOT a retryable "transient" bounce. `EREQUEST`
// (a SQL Server message) + `EABORT` stay unmapped: bucketing them needs the
// wrapped SQL error `.number`, so a coarse guess here would mislead.
const MSSQL_CODE_CLASS: Record<string, ErrorClass> = {
  ELOGIN: "upstream_auth", // login failed
  EFEDAUTH: "upstream_auth", // federated-auth failure
  EENCRYPT: "upstream_tls", // TLS encryption negotiation failed
  ETIMEOUT: "timeout", // connection / request timeout
  ECANCEL: "timeout", // request cancelled
  ESOCKET: "transient", // socket error
  EINSTLOOKUP: "transient", // SQL Server instance (SQL Browser) lookup failed
  ECONNCLOSED: "logic", // request on an explicitly-closed pool (misuse)
  ENOTOPEN: "logic", // connection not yet open / closing (misuse)
  ENOCONN: "logic", // no connection specified for the request (misuse)
  EALREADYCONNECTED: "logic",
  EALREADYCONNECTING: "logic",
  EDRIVER: "logic", // unknown driver (config bug)
};

/** Map a tedious/node-mssql error to a bucket via its `.code`. */
function classifyMssqlError(err: unknown): ErrorClass | null {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && code in MSSQL_CODE_CLASS) return MSSQL_CODE_CLASS[code]!;
  return null;
}

// SMB / CIFS NTSTATUS codes (@marsaud/smb2 sets the NTSTATUS name on `.code`,
// e.g. "STATUS_LOGON_FAILURE"; source: @marsaud/smb2 lib/tools/message.js +
// ms_erref.js). Socket-level failures pass through as POSIX `.code` (handled by
// the network/transient classifiers).
const SMB_STATUS_CLASS: Record<string, ErrorClass> = {
  STATUS_LOGON_FAILURE: "upstream_auth",
  STATUS_PASSWORD_EXPIRED: "upstream_auth",
  STATUS_ACCOUNT_DISABLED: "upstream_auth",
  STATUS_ACCESS_DENIED: "upstream_auth",
  STATUS_BAD_NETWORK_NAME: "resource", // share does not exist
  STATUS_NETWORK_NAME_DELETED: "resource",
  STATUS_OBJECT_NAME_NOT_FOUND: "resource",
  STATUS_OBJECT_PATH_NOT_FOUND: "resource",
  STATUS_OBJECT_NAME_COLLISION: "resource",
  STATUS_SHARING_VIOLATION: "resource",
  STATUS_DISK_FULL: "resource",
  STATUS_TIMEOUT: "timeout",
};

// SFTP codes that survive the ssh2-sftp-client wrapper on `.code` (source:
// ssh2-sftp-client src/constants.js + index.js fmtError). The wrapper STRIPS
// ssh2's `.level`, so auth/handshake/timeout collapse to "ERR_GENERIC_CLIENT"
// (message-only) and are deliberately NOT mapped here — see the consistency
// notes; classifying them would require message matching.
const SFTP_CODE_CLASS: Record<string, ErrorClass> = {
  ENOENT: "resource", // remote file/dir does not exist
  EACCES: "upstream_auth", // permission denied
  ENOTDIR: "validation",
  ERR_BAD_PATH: "validation",
  ERR_NOT_CONNECTED: "logic", // op issued with no live session (misuse)
};

/** Map an SMB (NTSTATUS) or SFTP-wrapper `.code` to a bucket. */
function classifyFileShareError(err: unknown): ErrorClass | null {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string") return null;
  if (code in SMB_STATUS_CLASS) return SMB_STATUS_CLASS[code]!;
  if (code in SFTP_CODE_CLASS) return SFTP_CODE_CLASS[code]!;
  return null;
}

/**
 * Map a basic-ftp `FTPError` by its numeric reply code (`.code`, e.g. 530).
 * basic-ftp throws `FTPError` (name === "FTPError") with the RFC-959 reply code
 * on `.code` for any server reply ≥ 400 (source: basic-ftp FtpContext.js). Its
 * own inactivity timeouts/disconnects are message-only (bare Error, no code) and
 * are deliberately not matched here.
 */
function classifyFtpError(err: unknown): ErrorClass | null {
  if ((err as { name?: unknown } | null | undefined)?.name !== "FTPError") return null;
  const code = Number((err as { code?: unknown }).code);
  if (!Number.isInteger(code)) return null;
  if (code === 530 || code === 532) return "upstream_auth"; // not logged in / need account
  if (code === 550 || code === 552 || code === 553) return "resource"; // file unavailable
  if (code === 421 || code === 425 || code === 426) return "transient"; // service / data conn
  if (code >= 500 && code < 510) return "logic"; // syntax / not implemented (usage bug)
  if (code >= 400) return "upstream_4xx"; // any other negative completion reply
  return null;
}

// node-redis error classes set NEITHER `.code` NOR `.name` (source:
// @redis/client lib/errors.js — confirmed: no `.name =` / `.code =`), so they
// are distinguishable only by `constructor.name`. The engine binary is built
// WITHOUT minification (no `--minify` on the `bun build --compile`), so class
// names are preserved; if that ever changes this gracefully returns null
// (→ unknown). The `authx` credential classes DO set `.name` (= constructor
// name), so they match here too.
const REDIS_CLIENT_CLASS: Record<string, ErrorClass> = {
  ConnectionTimeoutError: "timeout",
  SocketTimeoutError: "timeout",
  SocketClosedUnexpectedlyError: "transient",
  ReconnectStrategyError: "transient",
  RootNodesUnavailableError: "transient",
  ClientClosedError: "logic",
  ClientOfflineError: "logic",
  DisconnectsClientError: "logic",
  WatchError: "logic",
  CredentialsError: "upstream_auth",
  UnableToObtainNewCredentialsError: "upstream_auth",
  IDPError: "upstream_auth",
};

// A redis server REPLY error (constructor `ErrorReply`/`SimpleError`/
// `BlobError`) carries the RESP-protocol error code as the LEADING token of its
// message (e.g. "NOAUTH Authentication required") — a documented protocol field
// that just lives in the message, not a fuzzy guess. We only read this token
// when the constructor confirms it's a redis reply error.
const REDIS_REPLY_CLASSES = new Set<string>(["ErrorReply", "SimpleError", "BlobError"]);
const REDIS_REPLY_TOKEN_CLASS: Record<string, ErrorClass> = {
  NOAUTH: "upstream_auth",
  WRONGPASS: "upstream_auth",
  NOPERM: "upstream_auth",
  CLUSTERDOWN: "upstream_5xx",
  LOADING: "upstream_5xx",
  MASTERDOWN: "upstream_5xx",
  READONLY: "upstream_5xx",
  OOM: "resource",
  WRONGTYPE: "logic",
  NOSCRIPT: "logic",
};

/** Map a node-redis client error (by `constructor.name`) or server reply error
 *  (by its RESP protocol token) to a bucket. */
function classifyRedisError(err: unknown): ErrorClass | null {
  const ctor = (err as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name;
  if (typeof ctor !== "string") return null;
  if (ctor in REDIS_CLIENT_CLASS) return REDIS_CLIENT_CLASS[ctor]!;
  if (REDIS_REPLY_CLASSES.has(ctor)) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string") {
      const token = (msg.split(" ", 1)[0] ?? "").toUpperCase();
      if (token in REDIS_REPLY_TOKEN_CLASS) return REDIS_REPLY_TOKEN_CLASS[token]!;
    }
  }
  return null;
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
