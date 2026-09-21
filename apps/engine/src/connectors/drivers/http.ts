// HTTP driver. Resolves connector + credentials and mutates a request
// descriptor so the caller's fetch() lands with the right Authorization
// header, basic-auth base64, bearer token, or appended query.
//
// The driver is intentionally small — it does NOT re-implement the
// retry, timeout, pagination, or filter logic from the P3 request step.
// Instead, the request step imports `applyAuthToRequest` below to mix
// connector auth into its existing HTTP pipeline.
//
// Auth contract: when auth_type !== "none" and no credential row exists,
// the driver surfaces a structured credential_required error rather than
// sending an unauthenticated request. Callers must persist a credential
// via save_connector_draft({credential}) before probing.

import { getConfig, isConfigLoaded } from "../../config/loader.ts";
import type { ConnectionAuthorityIdentity } from "../../credentials/authority-metadata.ts";
import { refreshIfStale } from "../../credentials/oauth2/refresh-worker.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import type { DecryptedCredential } from "../../credentials/types.ts";
import type { Db } from "../../db/client.ts";
import { log } from "../../logging/logger.ts";
import { instrument } from "../../observability/runtime-telemetry.ts";
import { injectTraceContext, scrubUrl } from "../egress.ts";
import { assertEgressAllowedResolved, assertRobotsAllowed } from "../egress-guard.ts";
import { getConnectorProbeEndpoint } from "../template-binding.ts";
import { type ProbeEndpoint, ProbeEndpointSchema } from "../templates.ts";
import type { ConnectorView } from "../types.ts";
import { settleOnAbort } from "./abort-boundary.ts";
import { signSigV4Request } from "./aws-sigv4.ts";
import { getDriverFetch } from "./fetch-seam.ts";
import { shouldPromoteToFile } from "./file-promotion.ts";
import { buildProbeDiagnostics } from "./probe-diagnostics.ts";
import { resolveUrl } from "./resolve-url.ts";

// Re-export so callers that already import from this driver can catch
// the SSRF-block error without taking a direct dependency on the guard.
export { EgressBlockedError } from "../egress-guard.ts";

/**
 * Thrown when the request descriptor would produce a malformed wire
 * request — e.g. a header name that isn't an RFC 7230 token, or a
 * non-string header value. Always non-retryable; the retry loop in
 * `execution/steps/request.ts` recognises this class and converts it
 * into a `RequestError("…", "request_invalid")`.
 */
export class HttpRequestInvalidError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = "HttpRequestInvalidError";
  }
}

// Per-attempt outbound fetch deadline. Bun/undici fetch has NO default
// timeout, so a TCP-connected-but-unresponsive upstream hangs forever.
// 60s is generous (slow-but-alive APIs are never cut off) and matches the
// existing default used below; the graphql driver, webhook-notification
// channel, and outbound delivery worker import this so all four agree.
export const FETCH_DEADLINE_MS = 60_000;

// Default hard cap on a single connector response body (100 MB). Keep in
// sync with the `.default()` on `connectors.http.max_response_bytes` in
// config/schema.ts — that config leaf is the live source of truth; this
// constant is the value used when config has not been loaded (driver
// functions exercised directly in unit tests before any loadConfig()).
export const DEFAULT_MAX_RESPONSE_BYTES = 104_857_600;

/**
 * Resolve the per-response byte cap from tenant config, falling back to
 * DEFAULT_MAX_RESPONSE_BYTES when the config subsystem has not been
 * bootstrapped. In production config is always loaded before the HTTP
 * listener accepts traffic, so the real configured value is always used;
 * the default branch exists only for low-level driver unit tests.
 */
export function resolveMaxResponseBytes(tenant_id?: string): number {
  return isConfigLoaded()
    ? getConfig(tenant_id).connectors.http.max_response_bytes
    : DEFAULT_MAX_RESPONSE_BYTES;
}

/**
 * Read a fetch Response body into a Buffer with a HARD byte cap, so a
 * single oversized upstream response can't OOM the engine. Rejects early
 * on a Content-Length over the cap; for chunked / unknown-length bodies it
 * streams and aborts once the cumulative size exceeds the cap. Throws
 * `HttpRequestInvalidError` (classified non-retryable / `request_invalid`
 * by the request step) so the retry ladder doesn't re-pull the body.
 * Falls back to `res.arrayBuffer()` when the body isn't a readable stream
 * (e.g. a mocked Response in tests), still honouring the Content-Length
 * pre-check. Byte-preserving: binary bodies survive intact — the UTF-8
 * decode is the caller's (lossy) choice via `readBodyCapped`.
 */
export async function readBodyBytesCapped(
  res: Response,
  maxBytes: number,
  path: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const cl = res.headers.get("content-length");
  if (cl) {
    const declared = Number(cl);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new HttpRequestInvalidError(
        `response too large: ${declared} bytes exceeds max_response_bytes ${maxBytes}`,
        path,
      );
    }
  }
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    const buf = Buffer.from(await awaitWithAbort(res.arrayBuffer(), signal));
    if (buf.byteLength > maxBytes) {
      throw new HttpRequestInvalidError(
        `response too large: exceeds max_response_bytes ${maxBytes}`,
        path,
      );
    }
    return buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await awaitWithAbort(reader.read(), signal, () => {
      void reader.cancel().catch(() => {});
    });
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new HttpRequestInvalidError(
          `response too large: exceeds max_response_bytes ${maxBytes}`,
          path,
        );
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

/** UTF-8-decoding wrapper over `readBodyBytesCapped` for callers that
 *  only ever consume text bodies (graphql driver, spec fetchers). */
export async function readBodyCapped(
  res: Response,
  maxBytes: number,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  return (await readBodyBytesCapped(res, maxBytes, path, signal)).toString("utf8");
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

async function awaitWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) return await operation;
  if (signal.aborted) {
    onAbort?.();
    throw abortError(signal);
  }
  let handleAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    handleAbort = () => {
      onAbort?.();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });
  try {
    const result = await Promise.race([operation, aborted]);
    // Bun may resolve a pending body read with `{ done: true }` when fetch's
    // signal aborts instead of rejecting that read. The signal is still the
    // authority: never turn an aborted response into a successful empty body.
    if (signal.aborted) throw abortError(signal);
    return result;
  } finally {
    if (handleAbort) signal.removeEventListener("abort", handleAbort);
  }
}

// RFC 7230 §3.2.6 token characters.
export const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Validate that `headers` is a `{string: string}` record whose keys are
 * RFC 7230 tokens and whose values are strings. Throws
 * `HttpRequestInvalidError` on any violation. Exported so non-HTTP
 * drivers (graphql) and the discovery / spec-fetcher surfaces can call
 * the same check before reaching `fetch()`. Defends against the
 * conversation 730c568a class of bug on every fetch path, not only the
 * HTTP driver.
 */
export function validateOutboundHeaders(headers: unknown): void {
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    throw new HttpRequestInvalidError(
      `headers must be a {string: string} record, got ${Array.isArray(headers) ? "array" : typeof headers}`,
      "headers",
    );
  }
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (!HTTP_HEADER_NAME_RE.test(name)) {
      throw new HttpRequestInvalidError(
        `header name "${name}" is not an RFC 7230 token — fix the workflow's headers field`,
        `headers.${name}`,
      );
    }
    if (typeof value !== "string") {
      throw new HttpRequestInvalidError(
        `header "${name}" must be a string, got ${typeof value}`,
        `headers.${name}`,
      );
    }
  }
}

export interface HttpRequestDescriptor {
  base_url: string | null;
  path_or_url: string; // either an absolute URL or a path relative to base_url
  headers: Record<string, string>;
  query: Record<string, string | number | boolean>;
}

/**
 * Mutate a header/query bag according to the credential's auth mode.
 * Header/query values authored on the connector (`config.static_headers`,
 * `config.static_query`) land on the request too.
 */
export function applyAuthMaterial(
  connector: ConnectorView,
  credential: DecryptedCredential | null,
  headers: Record<string, string>,
  query: Record<string, string | number | boolean>,
): void {
  const cfg = (connector.config ?? {}) as {
    static_headers?: Record<string, string>;
    static_query?: Record<string, string>;
  };
  if (cfg.static_headers) {
    for (const [k, v] of Object.entries(cfg.static_headers)) {
      headers[k] = v;
    }
  }
  if (cfg.static_query) {
    for (const [k, v] of Object.entries(cfg.static_query)) {
      query[k] = v;
    }
  }
  if (!credential) {
    // No credential row — static headers/query still apply, but auth
    // material cannot be injected. Callers that require auth must gate
    // on credential_required before reaching here (see probeHttpConnector).
    return;
  }
  switch (credential.mode) {
    case "none":
      return;
    case "header":
      for (const [k, v] of Object.entries(credential.headers)) {
        headers[k] = v;
      }
      return;
    case "query":
      for (const [k, v] of Object.entries(credential.query)) {
        query[k] = v;
      }
      return;
    case "bearer":
      headers.Authorization = `Bearer ${credential.token}`;
      return;
    case "basic": {
      const encoded = Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString(
        "base64",
      );
      headers.Authorization = `Basic ${encoded}`;
      return;
    }
    case "aws_sigv4":
      // SigV4 needs the URL + method + body to compute the canonical
      // request — we can't sign here. The dispatch path
      // (`executePlannedHttpRequest`) checks the credential mode and
      // calls `signSigV4Request` right before fetch. This branch is a
      // no-op so the switch stays exhaustive.
      return;
    case "oauth2": {
      // `token_type` controls the Authorization scheme.
      //
      // - "Bearer" (RFC 6750) is the common case — Linear, GitHub, Monday,
      //   Auth0, Cognito client-credentials.
      // - Empty / null / "none" / "no_prefix" → emit the token VERBATIM
      //   without a scheme prefix. Required by AppSync Cognito User-Pool
      //   auth and Lambda authorizer flows that expect the raw JWT
      //   (`Authorization: eyJ…`), and tolerant of IdPs that return
      //   `token_type: ""`.
      //
      // Case normalization: Google's OAuth2 token endpoint returns
      // `token_type: "bearer"` (lowercase), Microsoft Graph returns
      // "Bearer", Slack returns "Bearer", Atlassian returns "bearer".
      // RFC 6749 §5.1 says the comparison is case-insensitive, but
      // Google's resource APIs (Gmail, Drive, …) reject the lowercase
      // form with 401. Canonicalise "bearer"/"BEARER"/etc. to the
      // titlecased "Bearer" so the header is interoperable across
      // every provider we connect to.
      //
      // Empty access_token (credential row exists but the OAuth2 dance
      // never minted a token, or it was cleared) leaves Authorization
      // unset so the request errors with a clear upstream 401 instead of
      // sending an empty/garbage Bearer. Mirrors the token_mint branch.
      if (!credential.access_token) return;
      const scheme = (credential.token_type ?? "").trim();
      if (scheme === "" || /^(none|no_prefix)$/i.test(scheme)) {
        headers.Authorization = credential.access_token;
      } else if (scheme.toLowerCase() === "bearer") {
        headers.Authorization = `Bearer ${credential.access_token}`;
      } else {
        // Non-bearer scheme (rare: "MAC", "DPoP", custom). Preserve the
        // case the IdP returned — the consumer chose this scheme on
        // purpose.
        headers.Authorization = `${scheme} ${credential.access_token}`;
      }
      return;
    }
    case "token_mint": {
      // A4: Cognito InitiateAuth, Firebase signInWithPassword, generic
      // POST /login. The mint client cached `access_token` on the row.
      // `header_template` defaults to `Bearer ${token}` — the only
      // substitution token is `${token}`. Empty access_token (first
      // request before the initial mint runs) leaves Authorization
      // unset so the request errors with a clear upstream 401 instead
      // of a malformed header.
      if (!credential.access_token) return;
      // biome-ignore lint/suspicious/noTemplateCurlyInString: header_template is operator-supplied and ${token} is a literal placeholder, not a JS template
      const tpl = credential.header_template ?? "Bearer ${token}";
      // biome-ignore lint/suspicious/noTemplateCurlyInString: matches the literal placeholder above
      headers.Authorization = tpl.replaceAll("${token}", credential.access_token);
      return;
    }
    case "oauth2_client":
      // RFC 7591 registered client identity. Not callable auth material —
      // it drives the OAuth2 authorize / refresh dance via the token
      // endpoint, not outgoing HTTP requests. Reaching this arm means a
      // caller resolved an `oauth2_client` credential where a primary
      // mode (oauth2/bearer/etc.) was expected — fail loudly so the
      // upstream lookup can be corrected rather than silently emitting
      // an unauthenticated request.
      throw new Error(
        "oauth2_client credentials are not directly applied to HTTP requests — they identify the registered OAuth2 client and are consumed by the token endpoint flow.",
      );
    case "oauth2_private_key":
      // M2M private key for external MCP servers. Not applicable to the
      // connector HTTP driver — consumed only by the MCP client pool's
      // PrivateKeyJwtProvider, not by outgoing connector requests.
      throw new Error(
        "oauth2_private_key credentials are not directly applied to HTTP requests — they are consumed by the MCP client pool's PrivateKeyJwtProvider.",
      );
  }
  // Exhaustiveness guard: every CredentialMode must be handled above.
  const _exhaustive: never = credential;
  void _exhaustive;
}

export interface ResolveConnectorRequestParams {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  path_or_url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  /** Skip the `connector_credentials` lookup and use this credential
   *  verbatim. Used by `probe_connector_draft` to inject the
   *  in-memory draft credential before the connector has been
   *  persisted (no UUID-keyed row exists yet). Never use this for
   *  saved-connector traffic — go through `getCredentialForConnector`
   *  so audit, rotation, and OAuth refresh stay observable. */
  credential_override?: DecryptedCredential | null;
  /** Outbound idempotency key. When set the resolved plan injects an
   *  `Idempotency-Key` header so retried writes against remotes that honour
   *  the standard don't double-apply. Caller owns the key shape — the
   *  request step uses `${execution_id}:${step_id}:${attempt}` so each
   *  retry is a distinct key tracing back to a concrete attempt. GET /
   *  HEAD / OPTIONS callers should leave this unset. */
  idempotency_key?: string;
}

/** What auth was actually applied — observable at request time.
 *  `oauth2_refreshed` means a stale token was rotated inline before this
 *  request went out; `oauth2_static` means the cached token was still
 *  fresh. Debuggers can spot a token-rotation hiccup this way. */
export type AppliedAuthMethod =
  | "none"
  | "bearer"
  | "header"
  | "query"
  | "basic"
  | "oauth2_static"
  | "oauth2_refreshed"
  | "aws_sigv4"
  | "token_mint_static"
  | "token_mint_refreshed";

export interface ResolvedConnectorCredential {
  credential: DecryptedCredential | null;
  credential_id: string | null;
  credential_revision: number | null;
  connection_authority?: ConnectionAuthorityIdentity | null;
  /** True when the oauth2 path rotated a stale token inline. Always
   *  false for non-oauth2 modes. */
  oauth2_refreshed: boolean;
}

/** An authorized static target cannot delegate its permission through a redirect. */
export interface RequestDispatchPolicy {
  redirect: "manual";
}

export interface HttpDispatchObservation {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  unsupported_body?: boolean;
}

export class AuthorityDispatchError extends Error {
  readonly code = "authority_invalid";
  constructor() {
    super("The redirect target requires separate authorization; no redirect was followed.");
    this.name = "AuthorityDispatchError";
  }
}

export async function checkAuthorityRedirect(
  response: Response,
  policy: RequestDispatchPolicy | undefined,
): Promise<void> {
  if (
    policy &&
    response.status >= 300 &&
    response.status < 400 &&
    response.headers.has("location")
  ) {
    try {
      await response.body?.cancel();
    } catch {
      // Cleanup failure must not turn a denied redirect into a retryable error.
    }
    throw new AuthorityDispatchError();
  }
}

/**
 * Shared credential resolver for any driver that uses connector auth.
 * Pulls the persisted credential row, decrypts it, and runs the inline
 * oauth2 refresh path if the token is near expiry. Drivers should use
 * this instead of calling `getCredentialForConnector` directly so
 * GraphQL / S3 / future drivers get the same refresh-on-stale guarantees
 * the HTTP driver has.
 *
 * The `override` parameter mirrors `buildRequestPlan`'s
 * `credential_override` slot — used by `probe_connector_draft` to test
 * pre-persist drafts.
 */
export async function resolveConnectorCredential(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  override?: DecryptedCredential | null;
}): Promise<ResolvedConnectorCredential> {
  if (p.override !== undefined) {
    return {
      credential: p.override,
      credential_id: null,
      credential_revision: null,
      oauth2_refreshed: false,
    };
  }
  if (p.connector.auth_type === "none") {
    return {
      credential: null,
      credential_id: null,
      credential_revision: null,
      oauth2_refreshed: false,
    };
  }
  const row = await getCredentialForConnector(
    p.tenant_id,
    p.connector.id,
    p.connector.environment,
    p.db,
  );
  if (!row) {
    return {
      credential: null,
      credential_id: null,
      credential_revision: null,
      oauth2_refreshed: false,
    };
  }
  let credential: DecryptedCredential = row.value;
  let oauth2_refreshed = false;
  if (credential.mode === "oauth2") {
    const preToken = credential.access_token;
    credential = await refreshIfStale(p.db, p.tenant_id, row.row, credential);
    if (credential.mode === "oauth2" && credential.access_token !== preToken) {
      oauth2_refreshed = true;
    }
  }
  return {
    credential,
    credential_id: row.row.id,
    credential_revision: row.row.authority_revision,
    connection_authority: row.connection_authority ?? null,
    oauth2_refreshed,
  };
}

/** Map a `DecryptedCredential` + the oauth2-refresh observation into the
 *  observable `AppliedAuthMethod`. Shared by HTTP, GraphQL, and any
 *  future driver. */
export function deriveAppliedAuthMethod(
  credential: DecryptedCredential | null,
  oauth2Refreshed: boolean,
): AppliedAuthMethod {
  if (!credential) return "none";
  switch (credential.mode) {
    case "none":
      return "none";
    case "bearer":
      return "bearer";
    case "header":
      return "header";
    case "query":
      return "query";
    case "basic":
      return "basic";
    case "oauth2":
      return oauth2Refreshed ? "oauth2_refreshed" : "oauth2_static";
    case "aws_sigv4":
      return "aws_sigv4";
    case "token_mint":
      // `oauth2Refreshed` is reused as the inline-refresh signal for
      // token_mint as well, since both modes share the
      // `refreshIfStale()` plumbing in the HTTP driver.
      return oauth2Refreshed ? "token_mint_refreshed" : "token_mint_static";
    case "oauth2_client":
      return "none";
    case "oauth2_private_key":
      return "none";
  }
}

export interface ResolvedRequestPlan {
  credential_revision: number | null;
  connection_authority: ResolvedConnectorCredential["connection_authority"];
  url: URL;
  headers: Record<string, string>;
  query: Record<string, string | number | boolean>;
  credential: DecryptedCredential | null;
  /** The credential row id, when a stored credential was used. Surfaces
   *  through to the egress audit (`CREDENTIAL_ACCESSED`) so an operator
   *  can answer "which credential was used for this request?" without
   *  re-running the lookup. */
  credential_id: string | null;
  auth_method: AppliedAuthMethod;
}

/**
 * One-shot: pull the connector's credential, apply it, and return a
 * ready-to-fetch plan. Used both by the request step runner and by the
 * connector.test route.
 */
export async function buildRequestPlan(
  p: ResolveConnectorRequestParams,
): Promise<ResolvedRequestPlan> {
  const headers = { ...(p.headers ?? {}) };
  const query = { ...(p.query ?? {}) };
  const resolveOpts: Parameters<typeof resolveConnectorCredential>[0] = {
    db: p.db,
    tenant_id: p.tenant_id,
    connector: p.connector,
  };
  if (p.credential_override !== undefined) {
    resolveOpts.override = p.credential_override;
  }
  const {
    credential,
    credential_id: credentialId,
    credential_revision: credentialRevision,
    connection_authority: connectionAuthority,
    oauth2_refreshed: oauth2Refreshed,
  } = await resolveConnectorCredential(resolveOpts);
  // Step-level `Authorization` wins over the connector credential.
  // Pre-fix `applyAuthMaterial` unconditionally clobbered it — so a
  // workflow author who minted a token in step N and tried to forward
  // it as `headers: { Authorization: "${scope.…}" }` to step N+1 saw
  // the explicit header overwritten by the connector's auth_type.
  // Session 8de01f2f spent four preview rounds before working around
  // by switching `auth_type` to `none`.
  const stepAuthHeader = headers.Authorization ?? headers.authorization ?? null;
  applyAuthMaterial(p.connector, credential, headers, query);
  if (stepAuthHeader) {
    delete headers.authorization;
    headers.Authorization = stepAuthHeader;
  }
  // Idempotency-Key — opt-in per-call, set by the request step for
  // non-idempotent methods. Pass-through; the value is plain text and is
  // not scrubbed by the egress audit (it's not a credential).
  if (p.idempotency_key) {
    headers["Idempotency-Key"] = p.idempotency_key;
  }
  const url = resolveUrl(p.connector.base_url, p.path_or_url);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, String(v));
  }
  const plan: ResolvedRequestPlan = {
    url,
    headers,
    query,
    credential,
    credential_id: credentialId,
    credential_revision: credentialRevision,
    connection_authority: connectionAuthority,
    auth_method: deriveAppliedAuthMethod(credential, oauth2Refreshed),
  };
  // SSRF guard: block private/loopback/link-local targets, including
  // public names whose DNS resolves into private space.
  await assertEgressAllowedResolved(url, { tenant_id: p.tenant_id });
  // Web-scraper connector robots.txt gate. The template opts in via the
  // `respects_robots` field on its JSON entry, mirrored into
  // `template_snapshot` at draft mint time. Other templates (Stripe,
  // GitHub, etc.) leave it false (the schema default) and are exempt
  // from the extra robots.txt round-trip; their endpoints are private
  // APIs, not crawlable origins.
  const snapshot = (p.connector.template_snapshot as { respects_robots?: unknown } | null) ?? null;
  if (snapshot?.respects_robots === true) {
    const cfg = getConfig(p.tenant_id).connectors.web_scraper.runtime;
    const respectRobots =
      typeof p.connector.config.respect_robots === "boolean"
        ? p.connector.config.respect_robots
        : cfg.respect_robots;
    if (respectRobots) {
      const userAgent =
        typeof p.connector.config.user_agent === "string" &&
        p.connector.config.user_agent.length > 0
          ? p.connector.config.user_agent
          : cfg.user_agent;
      // The user agent on the actual fetch is also overridden so the
      // robots-parser verdict matches the wire UA.
      headers["User-Agent"] = userAgent;
      await assertRobotsAllowed(url, { tenant_id: p.tenant_id, userAgent });
    }
  }
  log.connector.request.planned({
    connector_id: p.connector.id,
    auth_type: p.connector.auth_type,
    url_host: url.host,
    url: scrubUrl(url),
    has_credential: credential !== null,
    oauth2_refreshed: oauth2Refreshed,
  });
  return plan;
}

export interface HttpExecutionResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bytes_in: number;
  url: string;
  /** Raw response bytes, set ONLY when the caller passed
   *  `capture_binary` and the 2xx body matched `shouldPromoteToFile`.
   *  When present, `body` is undefined — the bytes were never UTF-8
   *  decoded (the decode mangles binary payloads irreversibly). The
   *  workflow dispatch path persists these as an engine-managed file. */
  body_raw?: Buffer;
}

/**
 * Decide whether the Content-Type header is informative or not.
 * Servers that return JSON with `application/octet-stream`,
 * `text/plain`, or no header at all are common enough that we'd
 * rather sniff than mis-parse. The trusted-header path stays the
 * fast path: if the header explicitly says `application/json`,
 * `text/csv`, or any well-known text variant, we honour it without
 * inspecting body bytes.
 */
function shouldSniff(contentType: string): boolean {
  if (!contentType) return true;
  const ct = contentType.toLowerCase();
  if (ct.includes("application/octet-stream")) return true;
  if (ct === "text/plain" || ct.startsWith("text/plain;")) return true;
  return false;
}

/**
 * Body content sniffer — reads the first ~512 bytes and decides
 * whether the payload looks like JSON, XML, or CSV. Keep the
 * heuristics conservative (`{` or `[` for JSON; `<?xml`/`<root>` for
 * XML; comma-delimited header line for CSV) so we never mis-classify
 * arbitrary text. Returns `null` when no shape matches; caller falls
 * back to the raw text.
 */
function sniffBodyShape(text: string): "json" | "xml" | "csv" | null {
  const sample = text.slice(0, 512).trimStart();
  if (!sample) return null;
  if (sample.startsWith("{") || sample.startsWith("[")) return "json";
  if (sample.startsWith("<?xml") || /^<[a-z_][\w:.-]*[\s>]/i.test(sample)) return "xml";
  // CSV heuristic: header line is a comma-delimited list of identifier-
  // ish tokens (no internal spaces) AND the body has at least one
  // additional row. Requiring identifier-shaped header cells avoids
  // false positives on prose ("just some prose, nothing structured" —
  // both cells contain spaces).
  const lines = sample.split(/\r?\n/);
  if (lines.length >= 2) {
    const header = lines[0] ?? "";
    if (header.includes(",")) {
      const cells = header.split(",");
      const looksLikeIdentifierHeader =
        cells.length >= 2 && cells.every((c) => /^[A-Za-z_][\w\-.]{0,63}$/.test(c.trim()));
      const secondLineHasContent = (lines[1] ?? "").trim().length > 0;
      if (looksLikeIdentifierHeader && secondLineHasContent) return "csv";
    }
  }
  return null;
}

/** Content-types that carry JSON payloads but don't say "application/json"
 *  in the header. Pre-fix the parser only honoured `application/json` so
 *  AWS Cognito IDP responses (`application/x-amz-json-1.1`) and AWS
 *  service responses generally were returned to the workflow scope as
 *  raw strings — the LLM had to call `$parseJson()` in JSONata and
 *  session 8de01f2f spent five preview rounds debugging a string-typed
 *  IdToken before figuring this out. */
function isJsonContentType(contentType: string): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return (
    ct.includes("application/json") ||
    ct.includes("application/x-amz-json") || // AWS service APIs (Cognito IDP, DynamoDB, …)
    ct.includes("application/vnd.api+json") || // JSON:API
    ct.includes("application/ld+json") || // JSON-LD
    ct.includes("application/hal+json") || // HAL
    /\+json(\b|;)/.test(ct) // catch-all: any subtype ending in +json
  );
}

/** @internal Exported for unit tests; do not import outside http.ts. */
export function parseResponseBody(text: string, contentType: string): unknown {
  // Trusted-header fast path. JSON is the overwhelming majority of
  // responses we see; honour the header without sniffing.
  if (isJsonContentType(contentType) && text.length > 0) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  // Magic-byte sniff for headers that don't disclose the real shape
  // (octet-stream, text/plain, missing). Returning the parsed JSON /
  // CSV row array here lets a downstream `data_selector` work even
  // when the vendor didn't set Content-Type properly.
  if (shouldSniff(contentType) && text.length > 0) {
    const shape = sniffBodyShape(text);
    if (shape === "json") {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    if (shape === "csv") {
      return parseCsvBody(text);
    }
    if (shape === "xml") {
      const parsed = parseXmlBody(text);
      if (parsed !== null) return parsed;
      // Fall through to raw text on malformed XML.
    }
  }
  return text;
}

/**
 * Tiny tag-soup XML parser. Handles enough of XML 1.0 + namespaces to
 * convert SOAP / XML-RPC / RSS responses into a JSONata-friendly tree:
 *
 *   <root xmlns:ns="…"><a id="1">x</a><a id="2">y</a></root>
 *     →  { "root": { "a": [ { "@id": "1", "#text": "x" },
 *                            { "@id": "2", "#text": "y" } ] } }
 *
 * Conventions:
 *   - Attributes are prefixed `@` so they sit alongside element
 *     children without colliding with element names.
 *   - Repeated child elements collapse to an array (the typical
 *     vendor convention; single-child cases stay as an object).
 *   - Text content lives at `#text` so a node with both attributes
 *     and text reads cleanly.
 *   - Namespace prefixes (`ns:tag`) keep the prefix in the key so
 *     authors can address them without inventing local-name munging.
 *   - Self-closing tags become `null`.
 *   - CDATA segments are concatenated into `#text` verbatim.
 *
 * Returns `null` on any parse failure so the caller falls back to the
 * raw text.
 */
/**
 * Serialize a structured value back into XML using the same
 * conventions the parser produces. `@attr` keys become attributes,
 * `#text` becomes text content, arrays become repeated elements.
 * Unknown values stringify via `String(value)`. Used for symmetric
 * `xml: { … }` request bodies — operators can build the same tree
 * shape they consume.
 */
// `serializeXmlBody` and `parseXmlBody` live in `utils/xml-parser.ts`.
// They are re-exported here only for the existing test mirror and
// `execution/steps/request.ts` consumer; future callers should import
// from `@engine/utils/xml-parser.ts` directly.
export { serializeXmlBody } from "../../utils/xml-parser.ts";

import { parseXmlBody } from "../../utils/xml-parser.ts";

/**
 * Tiny RFC-4180-ish CSV parser. Handles double-quoted fields with
 * embedded commas + escaped double-quotes; trims the trailing newline.
 * The first row is treated as a header; downstream rows render as
 * objects keyed by header name. Returns an empty array on any parse
 * failure rather than throwing — the caller can fall back to text.
 */
function parseCsvBody(text: string): Array<Record<string, string>> {
  try {
    const rows: string[][] = [];
    let cur: string[] = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          cur.push(field);
          field = "";
        } else if (ch === "\n" || ch === "\r") {
          if (ch === "\r" && text[i + 1] === "\n") i++;
          cur.push(field);
          rows.push(cur);
          cur = [];
          field = "";
        } else {
          field += ch;
        }
      }
    }
    if (field.length > 0 || cur.length > 0) {
      cur.push(field);
      rows.push(cur);
    }
    if (rows.length === 0) return [];
    const header = rows[0]!;
    return rows.slice(1).map((cells) => {
      const obj: Record<string, string> = {};
      for (let i = 0; i < header.length; i++) {
        obj[header[i]!] = cells[i] ?? "";
      }
      return obj;
    });
  } catch {
    return [];
  }
}

// Platform `AbortSignal.any` — NOT hand-rolled addEventListener wiring,
// which leaked one listener per request onto the long-lived caller signal
// (never removed on completion → MaxListenersExceededWarning + retention).
function mergeSignals(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}

export interface ResolvedFilePart {
  name: string;
  file?: {
    openRead(): Promise<AsyncIterable<Uint8Array>>;
    filename: string;
    content_type: string | null;
    size_bytes: number;
  };
  value?: string;
  filename?: string;
  content_type?: string;
}

/**
 * Build a `FormData` body from resolved multipart parts. Parts that carry a
 * `file` reference are attached as `Blob`s; parts with `value` become plain
 * text fields. Large files (>50 MB) are spooled to tmpfile by the step-runner
 * before `buildMultipartBody` is called, so by the time we get here the
 * payload is bounded and we buffer all chunks into a single `Blob`.
 */
export async function buildMultipartBody(parts: ResolvedFilePart[]): Promise<FormData> {
  const form = new FormData();
  for (const part of parts) {
    if (part.file !== undefined) {
      const f = part.file;
      const effectiveFilename = part.filename ?? f.filename;
      const effectiveContentType =
        part.content_type ?? f.content_type ?? "application/octet-stream";
      let blob: Blob;
      // Collect chunks from the file stream; use Uint8Array<ArrayBuffer>
      // to satisfy the BlobPart constraint under strict TS lib.
      {
        const chunks: ArrayBuffer[] = [];
        for await (const raw of await f.openRead()) {
          // Copy into a plain ArrayBuffer so BlobPart is satisfied.
          const ab = raw.buffer.slice(
            raw.byteOffset,
            raw.byteOffset + raw.byteLength,
          ) as ArrayBuffer;
          chunks.push(ab);
        }
        blob = new Blob(chunks, { type: effectiveContentType });
      }
      form.append(part.name, blob, effectiveFilename);
    } else if (part.value !== undefined) {
      form.append(part.name, part.value);
    }
  }
  return form;
}

export async function executePlannedHttpRequest(params: {
  before_dispatch?: (
    request: HttpDispatchObservation,
  ) => Promise<RequestDispatchPolicy | undefined>;
  tenant_id: string;
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
  /** Pre-built multipart body. When present, overrides `body` and sets the
   *  request body to multipart/form-data (Content-Type is set by FormData
   *  automatically, so the caller MUST NOT set it manually). */
  multipartBody?: FormData;
  signal: AbortSignal;
  /** When set, the dispatch path runs SigV4 signing right before
   *  `fetch` — sigv4 needs the URL + method + body to compute the
   *  canonical request, so it can't run earlier. */
  sigv4?: {
    region: string;
    service: string;
    credential: import("../../credentials/types.ts").AwsSigV4CredentialValue;
  };
  /** Call-site contract of the workflow request step: when a 2xx body
   *  matches `shouldPromoteToFile`, return the raw bytes via `body_raw`
   *  instead of decoding them to text. Probes, `call_connector`, and
   *  the graphql driver never set this — their responses stay on the
   *  decode + parse path byte-for-byte as before. */
  capture_binary?: boolean;
}): Promise<HttpExecutionResult> {
  // Last-line defence: validate the headers contract the caller is
  // supposed to honour. The workflow draft schema and the connector
  // driver layer should both reject malformed values upstream, but
  // when something slips through (e.g. a JSON-encoded headers string
  // mis-parsed into `{'{"Accept"': '...'}` — conversation 730c568a)
  // `new Headers()` throws a TypeError that the retry loop classifies
  // as a transient connection error and retries 5×. Reject up front
  // so the operator sees a single, accurate `request_invalid` error.
  validateOutboundHeaders(params.headers);

  const headers = { ...params.headers };
  const init: RequestInit = {
    method: params.method,
    headers,
    signal: params.signal,
  };
  if (params.multipartBody !== undefined && params.method !== "GET" && params.method !== "HEAD") {
    // FormData sets the Content-Type boundary automatically; removing any
    // caller-supplied content-type header avoids a boundary mismatch.
    delete headers["content-type"];
    delete headers["Content-Type"];
    init.body = params.multipartBody;
  } else if (
    params.body !== undefined &&
    params.body !== null &&
    params.method !== "GET" &&
    params.method !== "HEAD"
  ) {
    init.body = typeof params.body === "string" ? params.body : JSON.stringify(params.body);
    if (!headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }
  }
  injectTraceContext(headers);
  // SigV4 must run AFTER content-type / trace headers are stamped (they
  // contribute to the canonical-headers hash) and BEFORE fetch.
  if (params.sigv4) {
    signSigV4Request({
      method: params.method,
      url: params.url,
      headers,
      body: typeof init.body === "string" ? init.body : undefined,
      region: params.sigv4.region,
      service: params.sigv4.service,
      credential: params.sigv4.credential,
    });
  }
  const dispatchPolicy = await params.before_dispatch?.({
    method: params.method,
    url: params.url.toString(),
    headers: params.headers,
    body: params.body ?? null,
    ...(params.multipartBody ? { unsupported_body: true } : {}),
  });
  if (dispatchPolicy) init.redirect = dispatchPolicy.redirect;
  const res = await instrument({
    module: "connector",
    action: "driver.http.request",
    level: "debug",
    thresholdMs: 1000,
    fields: { method: params.method, url_host: params.url.host },
    fn: () => settleOnAbort(getDriverFetch()(params.url, init), params.signal),
  });
  const maxResponseBytes = resolveMaxResponseBytes(params.tenant_id);
  await checkAuthorityRedirect(res, dispatchPolicy);
  const buf = await readBodyBytesCapped(
    res,
    maxResponseBytes,
    params.url.toString(),
    params.signal,
  );
  const headerObj: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headerObj[k] = v;
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (
    params.capture_binary &&
    res.status >= 200 &&
    res.status < 300 &&
    shouldPromoteToFile({
      status: res.status,
      content_type: contentType,
      content_disposition: res.headers.get("content-disposition"),
      bytes: buf,
    })
  ) {
    return {
      status: res.status,
      headers: headerObj,
      body: undefined,
      body_raw: buf,
      bytes_in: buf.byteLength,
      url: params.url.toString(),
    };
  }
  const text = buf.toString("utf8");
  return {
    status: res.status,
    headers: headerObj,
    body: parseResponseBody(text, contentType),
    bytes_in: buf.byteLength,
    url: params.url.toString(),
  };
}

export async function executeConnectorHttpRequest(params: {
  before_dispatch?: (
    credential: Pick<
      ResolvedConnectorCredential,
      "credential_id" | "credential_revision" | "connection_authority"
    >,
  ) => Promise<RequestDispatchPolicy | undefined>;
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  method: string;
  path_or_url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  signal?: AbortSignal;
  timeout_ms?: number;
  credential_override?: DecryptedCredential | null;
  idempotency_key?: string;
}): Promise<HttpExecutionResult> {
  const planArgs: ResolveConnectorRequestParams = {
    db: params.db,
    tenant_id: params.tenant_id,
    connector: params.connector,
    path_or_url: params.path_or_url,
    ...(params.headers ? { headers: params.headers } : {}),
    ...(params.query ? { query: params.query } : {}),
    ...(params.credential_override ? { credential_override: params.credential_override } : {}),
    ...(params.idempotency_key ? { idempotency_key: params.idempotency_key } : {}),
  };
  const plan = await buildRequestPlan(planArgs);
  const signals: AbortSignal[] = [];
  if (params.signal) signals.push(params.signal);
  let timeoutSignal: AbortSignal | null = null;
  if (params.timeout_ms !== undefined) {
    timeoutSignal = AbortSignal.timeout(params.timeout_ms);
    signals.push(timeoutSignal);
  }
  const signal =
    signals.length === 0
      ? AbortSignal.timeout(FETCH_DEADLINE_MS)
      : signals.length === 1
        ? signals[0]!
        : mergeSignals(signals);

  // SigV4 connector → derive the signer from the resolved credential
  // and the connector config (`aws_region`, `aws_service`).
  let sigv4Args: Parameters<typeof executePlannedHttpRequest>[0]["sigv4"] | undefined;
  if (plan.credential?.mode === "aws_sigv4") {
    const cfg = (params.connector.config ?? {}) as {
      aws_region?: unknown;
      aws_service?: unknown;
    };
    const region = typeof cfg.aws_region === "string" ? cfg.aws_region : "us-east-1";
    const service = typeof cfg.aws_service === "string" ? cfg.aws_service : null;
    if (!service) {
      throw new Error(
        `aws_sigv4 connector ${params.connector.id} missing required config.aws_service`,
      );
    }
    sigv4Args = { region, service, credential: plan.credential };
  }

  const beforeDispatch = params.before_dispatch;
  return await executePlannedHttpRequest({
    tenant_id: params.tenant_id,
    method: params.method,
    url: plan.url,
    headers: plan.headers,
    body: params.body,
    signal,
    ...(sigv4Args ? { sigv4: sigv4Args } : {}),
    ...(beforeDispatch
      ? {
          before_dispatch: () =>
            beforeDispatch({
              credential_id: plan.credential_id,
              credential_revision: plan.credential_revision,
              connection_authority: plan.connection_authority ?? null,
            }),
        }
      : {}),
  });
}

export interface HttpProbeResult {
  ok: boolean;
  latency_ms: number;
  status?: number;
  detail?: string;
  // When true the probe is advisory only — callers should not block on it.
  warning_only: boolean;
  warnings: Array<{ code: string; message: string }>;
  /**
   * G10 (runtime-logs review plan): typed error classification so the
   * LLM can branch on a discrete code instead of regex-matching
   * `detail`. Populated on every ok:false result.
   */
  error_code?:
    | "credential_missing"
    | "credential_invalid"
    | "credential_expired"
    | "scope_insufficient"
    | "remote_api_disabled"
    | "remote_resource_not_found"
    | "unknown_upstream_error";
  /** Optional provider-console deep link the operator can click. */
  provider_action_url?: string;
  /** Scrubbed, truncated (≤500 chars) upstream response body on ok:false. */
  body_snippet?: string;
  /**
   * Allowlisted diagnostic response headers (www-authenticate,
   * content-type, x-*auth/error/reason/login/deny/request-id*), values
   * scrubbed. Present on ok:false when the upstream sent any.
   */
  response_headers?: Record<string, string>;
}

/**
 * G10 / H3: classify an HTTP probe failure into a typed error_code
 * given the status code, the connector, and (when available) the
 * response body. Body-aware upgrades win over status-only buckets:
 *
 *   - Google APIs return JSON with `error.errors[].reason === "accessNotConfigured"`
 *     when an API has not been enabled in the GCP project. Status is
 *     usually 403; the body is the only signal that distinguishes
 *     this from a true permission denial (a `scope_insufficient`
 *     grant). H3 upgrades the classification to `remote_api_disabled`
 *     and synthesises the GCP console deep-link the operator can
 *     click to enable the API. Pre-H3 the model spent ~10 min of
 *     session ed20f48d chasing wrong hypotheses because the engine
 *     classified the failure as `scope_insufficient`.
 *
 *   - Atlassian / GitHub / Stripe equivalents are TODO — the H3 shape
 *     leaves room for them by accepting the body and dispatching
 *     per-provider; the catalog below grows as we observe new
 *     production signals.
 */
function detectAccessNotConfiguredBody(body: unknown): {
  matched: boolean;
  api_name?: string;
} {
  if (!body || typeof body !== "object") return { matched: false };
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") return { matched: false };
  const errors = (err as { errors?: unknown }).errors;
  const reasonMatches = (val: unknown): boolean =>
    typeof val === "object" &&
    val !== null &&
    (val as { reason?: unknown }).reason === "accessNotConfigured";
  if (Array.isArray(errors) && errors.some(reasonMatches)) {
    // Google's message is typically "Access Not Configured. <ApiName>
    // API has not been used in project <id> before or it is disabled."
    const message = (err as { message?: unknown }).message;
    const apiNameMatch =
      typeof message === "string" ? /\b([A-Z][A-Za-z]*?)\s+API\b/.exec(message) : null;
    const api_name = apiNameMatch?.[1];
    return api_name !== undefined ? { matched: true, api_name } : { matched: true };
  }
  return { matched: false };
}

function googleEnableApiDeepLink(connector: ConnectorView, api_name?: string): string | undefined {
  // Best-effort: the Google API library page uses lowercase service
  // names like `drive.googleapis.com`. Pre-fix the LLM had to
  // reconstruct this from training data — surfacing the deep link
  // here removes a guessing step. We synthesise from the connector
  // slug when the body did not name the API explicitly.
  const baseUrl =
    typeof connector.base_url === "string" && connector.base_url.length > 0
      ? connector.base_url
      : null;
  let service: string | undefined;
  if (api_name) {
    service = `${api_name.toLowerCase()}.googleapis.com`;
  } else if (baseUrl && /googleapis\.com/.test(baseUrl)) {
    const hostMatch = /https?:\/\/([a-z0-9-]+\.googleapis\.com)/i.exec(baseUrl);
    service = hostMatch?.[1];
  }
  if (!service) return undefined;
  return `https://console.cloud.google.com/apis/library/${service}`;
}

export function classifyHttpProbeStatus(
  status: number,
  connector: ConnectorView,
  body?: unknown,
): { code: HttpProbeResult["error_code"]; provider_action_url?: string } {
  // H3: body-aware upgrade BEFORE the status-only fallback. Google
  // emits `accessNotConfigured` on 403 (occasionally 404 in older
  // APIs) — both should classify as `remote_api_disabled`.
  if ((status === 403 || status === 404 || status === 400) && body !== undefined) {
    const ancBody = detectAccessNotConfiguredBody(body);
    if (ancBody.matched) {
      const deepLink = googleEnableApiDeepLink(connector, ancBody.api_name);
      return {
        code: "remote_api_disabled",
        ...(deepLink ? { provider_action_url: deepLink } : {}),
      };
    }
  }
  if (status === 401) return { code: "credential_invalid" };
  if (status === 403) return { code: "scope_insufficient" };
  if (status === 404) return { code: "remote_resource_not_found" };
  if (status >= 500) return { code: "unknown_upstream_error" };
  if (status >= 400) return { code: "unknown_upstream_error" };
  return { code: "unknown_upstream_error" };
}

function resolveProbeEndpointConfig(connector: ConnectorView): ProbeEndpoint | null {
  const raw = getConnectorProbeEndpoint(connector);
  if (raw === null || raw === undefined) return null;
  const parsed = ProbeEndpointSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpRequestInvalidError(
      `invalid connector probe_endpoint: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      "config.probe_endpoint",
    );
  }
  const config = parsed.data;
  if (connector.template_slug !== "notion") return config;
  const headers = { ...(config.headers ?? {}) };
  const hasVersion = Object.keys(headers).some((name) => name.toLowerCase() === "notion-version");
  if (!hasVersion) headers["Notion-Version"] = "2022-06-28";
  return { ...config, headers };
}

function assertProbeHeadersDoNotShadowCredential(
  config: ProbeEndpoint | null,
  credential: DecryptedCredential | null,
): void {
  if (!config?.headers || credential?.mode !== "header") return;
  const credentialNames = new Set(
    Object.keys(credential.headers).map((name) => name.toLowerCase()),
  );
  const shadowed = Object.keys(config.headers).find((name) =>
    credentialNames.has(name.toLowerCase()),
  );
  if (shadowed) {
    throw new HttpRequestInvalidError(
      `probe header "${shadowed}" is supplied by the saved credential`,
      `config.probe_endpoint.headers.${shadowed}`,
    );
  }
}

/**
 * Health probe: do a minimal request against the connector's base_url,
 * respecting `connector.config.probe_endpoint` when present.
 * Falls back to GET / and marks the result warning_only when the
 * fallback returns 404 or 405.
 */
export async function probeHttpConnector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  /** See `probeConnector` — a credential for a connector that is not saved yet. */
  credential_override?: DecryptedCredential | null;
}): Promise<HttpProbeResult> {
  const start = Date.now();
  try {
    if (!p.connector.base_url) {
      return {
        ok: false,
        latency_ms: 0,
        detail: "connector has no base_url",
        warning_only: false,
        warnings: [],
      };
    }

    // Guard: auth-required connectors must have a persisted credential row.
    // Without one the request would go out unauthenticated and 401/404 in a
    // way that is indistinguishable from a genuine connectivity failure.
    let probeCredential: DecryptedCredential | null = null;
    if (p.connector.auth_type !== "none") {
      // An override stands in for the persisted row when the connector is not
      // saved yet. `undefined` means "look it up"; an explicit `null` is a
      // caller saying there is no credential, and falls into the same
      // `credential_missing` answer as an absent row.
      const credRow =
        p.credential_override !== undefined
          ? p.credential_override && { value: p.credential_override }
          : await getCredentialForConnector(
              p.tenant_id,
              p.connector.id,
              p.connector.environment,
              p.db,
            );
      if (!credRow) {
        return {
          ok: false,
          latency_ms: 0,
          detail:
            "credential_required: probe requires a saved credential — collect one via ask_user_form and persist via save_connector_draft({credential})",
          warning_only: false,
          warnings: [
            {
              code: "CREDENTIAL_REQUIRED",
              message: "draft has no attached credential; cannot probe",
            },
          ],
          error_code: "credential_missing",
        };
      }
      probeCredential = credRow.value;
    }

    const probeConfig = resolveProbeEndpointConfig(p.connector);
    assertProbeHeadersDoNotShadowCredential(probeConfig, probeCredential);

    const method = probeConfig?.method ?? "GET";
    // Empty path means probe the base_url directly (no path segment appended).
    const pathOrUrl = probeConfig !== null && probeConfig.path !== "" ? probeConfig.path : "/";

    const res = await executeConnectorHttpRequest({
      db: p.db,
      tenant_id: p.tenant_id,
      connector: p.connector,
      method,
      path_or_url: pathOrUrl,
      ...(probeConfig?.headers ? { headers: probeConfig.headers } : {}),
      // Forward the override so the request itself authenticates with the same
      // material the guard above checked. Without this the guard would pass and
      // the request would then resolve nothing and go out unauthenticated.
      ...(p.credential_override !== undefined
        ? { credential_override: p.credential_override }
        : {}),
    });

    const latency_ms = Date.now() - start;
    const warnings: Array<{ code: string; message: string }> = [];
    let ok: boolean;
    let warning_only = false;

    if (probeConfig !== null) {
      // Explicit probe: success iff status is within the declared range.
      const [lo, hi] = probeConfig.expected_status ?? [200, 299];
      ok = res.status >= lo && res.status <= hi;
    } else {
      // Fallback probe: 404/405 from "GET /" is ambiguous — the service may
      // simply not expose that path, not a connectivity failure.
      if (res.status === 404 || res.status === 405) {
        ok = true;
        warning_only = true;
        warnings.push({
          code: "PROBE_AMBIGUOUS",
          message: `Fallback probe GET / returned ${res.status}; connectivity likely OK but endpoint unknown.`,
        });
      } else if (res.status === 401 || res.status === 403) {
        // An auth rejection is unambiguous even on the fallback "GET /" probe:
        // the service answered and rejected the credential. Mark not-ok so the
        // classifier below stamps credential_invalid / scope_insufficient —
        // otherwise a dead credential on a connector without an explicit probe
        // endpoint (the common case) would read as healthy (401 < 500).
        ok = false;
      } else {
        ok = res.status < 500;
      }
    }

    const result: HttpProbeResult = { ok, latency_ms, status: res.status, warning_only, warnings };
    // G10: typed classification on failure. Only assigned when the
    // probe truly failed (warning_only stays unclassified — it's
    // advisory, not an error). Authoritative-probe failures and
    // fallback-probe non-404/405 failures both pass through.
    if (!ok) {
      const classification = classifyHttpProbeStatus(res.status, p.connector, res.body);
      if (classification.code) {
        result.error_code = classification.code;
      }
      if (classification.provider_action_url) {
        result.provider_action_url = classification.provider_action_url;
      }
      // Stamp the upstream's own words (scrubbed body snippet +
      // allowlisted diagnostic headers) so a failed probe is
      // diagnosable without re-issuing the request.
      Object.assign(result, buildProbeDiagnostics(res.headers, res.body));
    }
    log.connector.probe.completed({
      connector_id: p.connector.id,
      ok: result.ok,
      latency_ms,
      status: res.status,
    });
    return result;
  } catch (err) {
    const result: HttpProbeResult = {
      ok: false,
      latency_ms: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
      warning_only: false,
      warnings: [],
    };
    log.connector.probe.completed({
      connector_id: p.connector.id,
      ok: result.ok,
      latency_ms: result.latency_ms,
      detail: result.detail,
    });
    return result;
  }
}
