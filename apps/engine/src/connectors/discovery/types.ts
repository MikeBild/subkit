// Public types for the multi-strategy OpenAPI / Swagger discovery module.
//
// Discovery answers the question "what endpoints does this third-party API
// expose?" at conversation time, so the agent can suggest concrete probe
// paths instead of guessing (e.g. `/account` vs `/v2/account` for
// DigitalOcean). The result is a curated, normalised endpoint index that
// downstream callers can persist as a `knowledge_sources` row of kind
// `connector_endpoint_index`.
//
// Strategies (in order of preference):
//   1. `openapi-direct`     — fetch a known spec URL and parse it.
//   2. `swagger-ui-scrape`  — page embeds Swagger UI; pull the spec URL
//                             out of the page's bootstrap, then delegate.
//   3. `html-scrape`        — last resort: try common well-known paths
//                             and look for embedded spec hrefs.
//
// This module is pure compute — no DB writes, no caching. The conversation
// tool wrapper persists results.

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type PaginationKind = "page" | "cursor" | "offset" | "link_header";

export interface DiscoveredEndpointParam {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  type: string | null;
}

export interface DiscoveredEndpointPaginationHint {
  kind: PaginationKind | null;
  param_names: string[];
}

export interface DiscoveredEndpoint {
  method: HttpMethod;
  path: string;
  summary: string | null;
  description: string | null;
  operation_id: string | null;
  /** OAuth2 scopes if declared on the operation. */
  scopes: string[];
  params: DiscoveredEndpointParam[];
  request_body_schema: unknown | null;
  /** Keyed by HTTP status code (e.g. "200", "default"). */
  response_schemas: Record<string, unknown>;
  pagination_hint: DiscoveredEndpointPaginationHint | null;
  deprecated: boolean;
}

export interface DiscoveredAuthSchemeOAuth2Flow {
  authorization_url?: string;
  token_url?: string;
  scopes?: Record<string, string>;
}

export interface DiscoveredAuthScheme {
  name: string;
  type: "apiKey" | "http" | "oauth2" | "openIdConnect";
  location?: "header" | "query" | "cookie";
  /** e.g. `bearer` | `basic`. */
  scheme?: string;
  flows?: Record<string, DiscoveredAuthSchemeOAuth2Flow>;
}

export interface DiscoveryWarning {
  code: string;
  message: string;
}

export type DiscoveryStrategyName = "openapi-direct" | "swagger-ui-scrape" | "html-scrape";

export interface DiscoveryResult {
  source_url: string;
  fetched_at: string;
  strategy: DiscoveryStrategyName;
  spec_version: "openapi-3" | "swagger-2" | null;
  title: string | null;
  servers: string[];
  auth_schemes: DiscoveredAuthScheme[];
  endpoints: DiscoveredEndpoint[];
  warnings: DiscoveryWarning[];
}

export interface DiscoveryStrategyOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface DiscoveryStrategy {
  name: DiscoveryStrategyName;
  canHandle(url: string): boolean | Promise<boolean>;
  fetch(url: string, opts: DiscoveryStrategyOptions): Promise<DiscoveryResult>;
}

/**
 * Typed error raised by discovery strategies. `code` is a short machine
 * tag (e.g. `spec_not_found`, `parse_failed`, `http_404`,
 * `all_strategies_failed`) suitable for log fields and warning entries.
 */
export class DiscoveryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DiscoveryError";
    this.code = code;
  }
}
