export type ConnectorHealth =
  | "ok"
  | "auth_failed"
  | "endpoint_gone"
  | "deprecated"
  | "not_found"
  | "rate_limited"
  | "degraded";

const SERAPH_LOGIN_REASON_HEADER = "x-seraph-loginreason";
const SERAPH_AUTH_FAILED = "AUTHENTICATED_FAILED";

export interface DeprecationSignal {
  deprecated: string;
  sunset: string | null;
  successor_uri: string | null;
}

export function parseDeprecation(headers?: Record<string, string>): DeprecationSignal | null {
  if (!headers) return null;
  const deprecation = headers.deprecation?.trim();
  const sunset = headers.sunset?.trim() || null;
  const successor_uri = parseDeprecationLink(headers.link);
  if (!deprecation && !sunset && !successor_uri) return null;
  return {
    deprecated: deprecation || "true",
    sunset,
    successor_uri,
  };
}

export interface LinkRelation {
  url: string;
  rels: string[];
}

export function parseLinkHeader(link: string | undefined | null): LinkRelation[] {
  if (!link) return [];
  return [...link.matchAll(/<([^>]+)>\s*;([^,]*)/g)].map((match) => ({
    url: match[1]!.trim(),
    rels: (/rel\s*=\s*"?([^";]+)"?/.exec(match[2]!.toLowerCase())?.[1] ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean),
  }));
}

function parseDeprecationLink(link: string | undefined): string | null {
  let docsUri: string | null = null;
  for (const relation of parseLinkHeader(link)) {
    if (relation.rels.includes("successor-version")) return relation.url;
    if (relation.rels.includes("deprecation")) docsUri = relation.url;
  }
  return docsUri;
}

function isRateLimitedResponse(status: number, headers?: Record<string, string>): boolean {
  if (status === 429) return true;
  if (status !== 403 || !headers) return false;
  return headers["x-ratelimit-remaining"]?.trim() === "0" || Boolean(headers["retry-after"]);
}

export function classifyConnectorHealth(
  status: number,
  headers?: Record<string, string>,
): ConnectorHealth {
  const seraph = headers?.[SERAPH_LOGIN_REASON_HEADER];
  if (seraph?.toUpperCase().includes(SERAPH_AUTH_FAILED)) {
    return "auth_failed";
  }
  if (isRateLimitedResponse(status, headers)) return "rate_limited";
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 410) return "endpoint_gone";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "degraded";
  if (status >= 200 && status < 400 && parseDeprecation(headers)) {
    return "deprecated";
  }
  return "ok";
}

export function isConnectorUnusable(health: ConnectorHealth): boolean {
  return health === "auth_failed" || health === "endpoint_gone";
}

export interface ConnectorHealthHint {
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

export interface ConnectorHealthHintContext {
  path?: string | null;
  deprecation?: DeprecationSignal | null;
  retry_after_s?: number | null;
}

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
          `Connector '${slug}' is rate-limited by the vendor.` +
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
