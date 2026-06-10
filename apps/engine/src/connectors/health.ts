// Connector-response health classification.
//
// A connector call can complete at the transport layer (no thrown error)
// yet prove the connector *unusable*: the credential was rejected, the
// endpoint was removed upstream, or the vendor is failing. Left unclassified,
// these collapse into "the call succeeded, the body is just empty" — which
// is how a dead Jira credential surfaced as "0 test plans" instead of
// "your Jira login is broken".
//
// This classifier is pure over (status, headers) so the ad-hoc
// `call_connector` surfaces, the workflow request-step executor, and the
// proactive scanners all share one verdict. It NEVER inspects the body —
// only the HTTP status and a small set of well-known headers.
//
// Verdict tiers — not every verdict means "connector broken":
//   connector-level faults  auth_failed, endpoint_gone   (unusable until fixed)
//   early warning           deprecated                   (2xx that announces removal)
//   request-level outcomes  not_found, rate_limited      (connector itself fine)
//   transient vendor fault  degraded                     (5xx — retry later)
// Use `isConnectorUnusable` when only the connector-level faults matter.

export type ConnectorHealth =
  | "ok"
  | "auth_failed"
  | "endpoint_gone"
  | "deprecated"
  | "not_found"
  | "rate_limited"
  | "degraded";

// Atlassian (Jira / Confluence, Seraph auth) serve an *unauthenticated*
// request as HTTP 200 with `X-Seraph-LoginReason: AUTHENTICATED_FAILED`
// rather than a 401 — a JQL search then returns an empty result set with a
// 200. This is the documented Seraph signal; the header name is unique to
// Atlassian, so matching it globally cannot misfire on another vendor.
const SERAPH_LOGIN_REASON_HEADER = "x-seraph-loginreason";
const SERAPH_AUTH_FAILED = "AUTHENTICATED_FAILED";

/**
 * Vendor deprecation announcement parsed from response headers. Vendors send
 * these on *successful* responses for months before an endpoint is removed
 * (e.g. Atlassian announced the `/rest/api/3/search` removal via
 * `Deprecation` + `Link rel="deprecation"` long before it started 410ing) —
 * parsing them converts "discover the removal at the final 410" into
 * "discover it inside the migration window".
 *
 * - `Deprecation`: `true` or an HTTP-date / @unix timestamp (RFC draft).
 * - `Sunset`: HTTP-date after which the endpoint stops working (RFC 8594).
 * - `Link`: `<uri>; rel="deprecation"` (docs) / `rel="successor-version"`
 *   (the replacement endpoint).
 */
export interface DeprecationSignal {
  /** ISO/HTTP date string when known, "true" when announced without a date. */
  deprecated: string;
  /** Sunset header value (HTTP-date) — when the endpoint stops working. */
  sunset: string | null;
  /** Replacement/documentation URI from the Link header, if announced. */
  successor_uri: string | null;
}

/**
 * Parse vendor deprecation headers. `headers` must use lowercased keys (the
 * HTTP driver normalizes them via `Headers.forEach`). Returns null when the
 * response carries no deprecation signal.
 */
export function parseDeprecation(headers?: Record<string, string>): DeprecationSignal | null {
  if (!headers) return null;
  const deprecation = headers.deprecation?.trim();
  const sunset = headers.sunset?.trim() || null;
  if (!deprecation && !sunset) return null;
  return {
    deprecated: deprecation || "true",
    sunset,
    successor_uri: parseDeprecationLink(headers.link),
  };
}

/**
 * Extract the deprecation/successor URI from a `Link` header. Handles
 * multiple comma-separated links; prefers `rel="successor-version"` (the
 * replacement endpoint) over `rel="deprecation"` (the announcement docs).
 */
function parseDeprecationLink(link: string | undefined): string | null {
  if (!link) return null;
  let docsUri: string | null = null;
  // `<uri>; rel="x"` segments — a quoted rel list may hold several tokens.
  for (const match of link.matchAll(/<([^>]+)>\s*;([^,]*)/g)) {
    const uri = match[1]!;
    const params = match[2]!.toLowerCase();
    const rel = /rel\s*=\s*"?([^";]+)"?/.exec(params)?.[1] ?? "";
    const tokens = rel.split(/\s+/);
    if (tokens.includes("successor-version")) return uri;
    if (tokens.includes("deprecation")) docsUri = uri;
  }
  return docsUri;
}

/**
 * Classify a completed connector response. `headers` must use lowercased
 * keys (the HTTP driver normalizes them via `Headers.forEach`).
 */
export function classifyConnectorHealth(
  status: number,
  headers?: Record<string, string>,
): ConnectorHealth {
  const seraph = headers?.[SERAPH_LOGIN_REASON_HEADER];
  if (seraph?.toUpperCase().includes(SERAPH_AUTH_FAILED)) {
    return "auth_failed";
  }
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 410) return "endpoint_gone";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "degraded";
  // A successful response that announces its own removal is an early
  // warning, not a failure — callers must NOT fail the request on it.
  if (status >= 200 && status < 400 && parseDeprecation(headers)) {
    return "deprecated";
  }
  return "ok";
}

/**
 * True only for the connector-level faults that make the connector unusable
 * until a human/agent intervenes. Request-level outcomes (not_found,
 * rate_limited), the deprecated early warning, and transient 5xx are NOT
 * unusable — callers that previously branched on `health !== "ok"` for
 * "is the connector broken?" must use this instead.
 */
export function isConnectorUnusable(health: ConnectorHealth): boolean {
  return health === "auth_failed" || health === "endpoint_gone";
}

export interface ConnectorHealthHint {
  /** Stable machine-readable code for routing/health rollup. */
  error_code:
    | "auth_rejected"
    | "endpoint_removed"
    | "endpoint_deprecated"
    | "resource_not_found"
    | "rate_limited"
    | "vendor_degraded";
  suggestion: string;
  next_best_actions: string[];
}

/** Optional request context that sharpens the hint text. */
export interface ConnectorHealthHintContext {
  /** Request path — enables path-aware guidance (e.g. /orgs/{x} vs /users/{x}). */
  path?: string | null;
  /** Parsed deprecation signal, when the caller already has it. */
  deprecation?: DeprecationSignal | null;
  /** Retry-After in seconds, when the caller parsed it. */
  retry_after_s?: number | null;
}

/**
 * Human/LLM-facing guidance for a non-ok verdict. Returns null for "ok" so
 * callers attach nothing on the healthy path. `slug` names the connector in
 * the suggestion so the model can tell the user which one to fix.
 */
export function connectorHealthHint(
  health: ConnectorHealth,
  slug: string,
  ctx?: ConnectorHealthHintContext,
): ConnectorHealthHint | null {
  switch (health) {
    case "auth_failed":
      return {
        error_code: "auth_rejected",
        suggestion: `Connector '${slug}' rejected authentication (the upstream served an unauthenticated/forbidden response). The saved credential is likely invalid or expired — re-authenticate the connector before retrying. An empty result here means "could not authenticate", not "no data".`,
        next_best_actions: ["setup_connector_credentials", "fetch_connector_docs"],
      };
    case "endpoint_gone":
      return {
        error_code: "endpoint_removed",
        suggestion:
          `Connector '${slug}' returned 410 Gone — the vendor has removed this endpoint/path.` +
          (ctx?.deprecation?.successor_uri
            ? ` The vendor announced a replacement: ${ctx.deprecation.successor_uri} — migrate the step/template to it.`
            : ` Check the connector's current API docs for the replacement path.`),
        next_best_actions: ["fetch_connector_docs"],
      };
    case "deprecated":
      return {
        error_code: "endpoint_deprecated",
        suggestion:
          `Connector '${slug}': this endpoint is deprecated by the vendor and will be removed` +
          (ctx?.deprecation?.sunset ? ` after ${ctx.deprecation.sunset}` : "") +
          `.` +
          (ctx?.deprecation?.successor_uri
            ? ` Replacement: ${ctx.deprecation.successor_uri}.`
            : "") +
          ` The call still succeeded — migrate before the vendor removes it.`,
        next_best_actions: ["fetch_connector_docs"],
      };
    case "not_found": {
      const orgsMatch = ctx?.path ? /^\/orgs\/([^/]+)(\/.*)?$/.exec(ctx.path) : null;
      return {
        error_code: "resource_not_found",
        suggestion: orgsMatch
          ? `Connector '${slug}' returned 404 — '${orgsMatch[1]}' may be a user account, not an organization. Try '/users/${orgsMatch[1]}${orgsMatch[2] ?? ""}' instead. A 404 here is a wrong path or identifier, not a broken connector.`
          : `Connector '${slug}' returned 404 Not Found — the path or identifier is wrong (or the resource does not exist). This is a request-level error, not a broken connector: verify the path/id before retrying.`,
        next_best_actions: ["fetch_connector_docs"],
      };
    }
    case "rate_limited":
      return {
        error_code: "rate_limited",
        suggestion:
          `Connector '${slug}' is rate-limited (429).` +
          (ctx?.retry_after_s != null
            ? ` The vendor asked to retry after ${ctx.retry_after_s}s.`
            : "") +
          ` Back off before retrying; authenticating (or a higher-tier credential) usually raises the limit.`,
        next_best_actions: ["setup_connector_credentials"],
      };
    case "degraded":
      return {
        error_code: "vendor_degraded",
        suggestion: `Connector '${slug}' returned a server error (5xx) — a transient vendor-side failure. Retry later.`,
        next_best_actions: [],
      };
    case "ok":
      return null;
  }
}
