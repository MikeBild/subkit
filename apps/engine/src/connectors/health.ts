// Connector-response health classification.
//
// A connector call can complete at the transport layer (no thrown error)
// yet prove the connector is *unusable*: the credential was rejected, the
// endpoint was removed upstream, or the vendor is failing. Left unclassified,
// these collapse into "the call succeeded, the body is just empty" — which
// is how a dead Jira credential surfaced as "0 test plans" instead of
// "your Jira login is broken".
//
// This classifier is pure over (status, headers) so both the ad-hoc
// `call_connector` surfaces and the workflow request-step executor can share
// one verdict. It NEVER inspects the body — only the HTTP status and a
// vendor-specific auth-failure header.

export type ConnectorHealth = "ok" | "auth_failed" | "endpoint_gone" | "degraded";

// Atlassian (Jira / Confluence, Seraph auth) serve an *unauthenticated*
// request as HTTP 200 with `X-Seraph-LoginReason: AUTHENTICATED_FAILED`
// rather than a 401 — a JQL search then returns an empty result set with a
// 200. This is the documented Seraph signal; the header name is unique to
// Atlassian, so matching it globally cannot misfire on another vendor.
const SERAPH_LOGIN_REASON_HEADER = "x-seraph-loginreason";
const SERAPH_AUTH_FAILED = "AUTHENTICATED_FAILED";

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
  if (status >= 500) return "degraded";
  return "ok";
}

export interface ConnectorHealthHint {
  suggestion: string;
  next_best_actions: string[];
}

/**
 * Human/LLM-facing guidance for a non-ok verdict. Returns null for "ok" so
 * callers attach nothing on the healthy path. `slug` names the connector in
 * the suggestion so the model can tell the user which one to fix.
 */
export function connectorHealthHint(
  health: ConnectorHealth,
  slug: string,
): ConnectorHealthHint | null {
  switch (health) {
    case "auth_failed":
      return {
        suggestion: `Connector '${slug}' rejected authentication (the upstream served an unauthenticated/forbidden response). The saved credential is likely invalid or expired — re-authenticate the connector before retrying. An empty result here means "could not authenticate", not "no data".`,
        next_best_actions: ["setup_connector_credentials", "fetch_connector_docs"],
      };
    case "endpoint_gone":
      return {
        suggestion: `Connector '${slug}' returned 410 Gone — the vendor has removed this endpoint/path. Check the connector's current API docs for the replacement path.`,
        next_best_actions: ["fetch_connector_docs"],
      };
    case "degraded":
      return {
        suggestion: `Connector '${slug}' returned a server error (5xx) — a transient vendor-side failure. Retry later.`,
        next_best_actions: [],
      };
    case "ok":
      return null;
  }
}
