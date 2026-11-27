import type { EgressTenantScope } from "../egress-guard.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type PaginationKind = "page" | "cursor" | "offset" | "link_header";

export interface DiscoveredEndpointParam {
  name: string;
  in: "path" | "query" | "header" | "cookie" | "body";
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
  scopes: string[];
  params: DiscoveredEndpointParam[];
  request_body_schema: unknown | null;
  request_content_type: string | null;
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
  scheme?: string;
  flows?: Record<string, DiscoveredAuthSchemeOAuth2Flow>;
  required?: boolean;
}

export interface DiscoveryWarning {
  code: string;
  message: string;
}

export type DiscoveryStrategyName =
  | "openapi-direct"
  | "graphql-introspect"
  | "postgres-introspect"
  | "swagger-ui-scrape"
  | "llms-txt"
  | "html-scrape"
  | "playwright-crawl";

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
  text_corpus?: string | null;
}

export type DiscoveryStrategyOptions = EgressTenantScope & {
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

export interface DiscoveryStrategy {
  name: DiscoveryStrategyName;
  canHandle(url: string): boolean | Promise<boolean>;
  fetch(url: string, opts: DiscoveryStrategyOptions): Promise<DiscoveryResult>;
}

export class DiscoveryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DiscoveryError";
    this.code = code;
  }
}
