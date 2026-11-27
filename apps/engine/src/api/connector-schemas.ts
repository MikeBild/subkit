import { z } from "@hono/zod-openapi";

export const DiscoveredEndpointParamSchema = z
  .object({
    name: z.string(),
    in: z.enum(["path", "query", "header", "cookie", "body"]),
    required: z.boolean(),
    type: z.string().nullable(),
  })
  .openapi("DiscoveredEndpointParam");

export const DiscoveredEndpointPaginationHintSchema = z
  .object({
    kind: z.enum(["page", "cursor", "offset", "link_header"]).nullable(),
    param_names: z.array(z.string()),
  })
  .openapi("DiscoveredEndpointPaginationHint");

export const DiscoveredEndpointSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
    path: z.string(),
    summary: z.string().nullable(),
    description: z.string().nullable(),
    operation_id: z.string().nullable(),
    scopes: z.array(z.string()),
    params: z.array(DiscoveredEndpointParamSchema),
    request_body_schema: z.unknown().nullable(),
    request_content_type: z.string().nullable(),
    response_schemas: z.record(z.string(), z.unknown()),
    pagination_hint: DiscoveredEndpointPaginationHintSchema.nullable(),
    deprecated: z.boolean(),
  })
  .openapi("DiscoveredEndpoint");

export const DiscoveredAuthSchemeOAuth2FlowSchema = z
  .object({
    authorization_url: z.string().optional(),
    token_url: z.string().optional(),
    scopes: z.record(z.string(), z.string()).optional(),
  })
  .openapi("DiscoveredAuthSchemeOAuth2Flow");

export const DiscoveredAuthSchemeSchema = z
  .object({
    name: z.string(),
    type: z.enum(["apiKey", "http", "oauth2", "openIdConnect"]),
    location: z.enum(["header", "query", "cookie"]).optional(),
    scheme: z.string().optional(),
    flows: z.record(z.string(), DiscoveredAuthSchemeOAuth2FlowSchema).optional(),
    required: z.boolean().optional(),
  })
  .openapi("DiscoveredAuthScheme");

export const DiscoveryWarningSchema = z
  .object({ code: z.string(), message: z.string() })
  .openapi("DiscoveryWarning");

export const DiscoveryStrategyNameEnum = z
  .enum([
    "openapi-direct",
    "graphql-introspect",
    "postgres-introspect",
    "swagger-ui-scrape",
    "llms-txt",
    "html-scrape",
    "playwright-crawl",
  ])
  .openapi("DiscoveryStrategyName");

export const DiscoveryResultSchema = z
  .object({
    source_url: z.string(),
    fetched_at: z.string(),
    strategy: DiscoveryStrategyNameEnum,
    spec_version: z.enum(["openapi-3", "swagger-2"]).nullable(),
    title: z.string().nullable(),
    servers: z.array(z.string()),
    auth_schemes: z.array(DiscoveredAuthSchemeSchema),
    endpoints: z.array(DiscoveredEndpointSchema),
    warnings: z.array(DiscoveryWarningSchema),
    text_corpus: z.string().nullable().optional(),
  })
  .openapi("DiscoveryResult");

const CallMethodEnum = z
  .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
  .openapi("ConnectorCallMethod");

export const ConnectorCallRequestSchema = z
  .object({
    method: CallMethodEnum.optional(),
    path: z.string().min(1).optional(),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    timeout_ms: z.number().int().min(1000).max(60_000).optional(),
  })
  .openapi("ConnectorCallRequest");

export const ConnectorCallMetadataSchema = z
  .object({
    connector_id: z.string(),
    connector_slug: z.string(),
    driver: z.string(),
    environment: z.string(),
    method: z.string(),
    path: z.string(),
    url_host: z.string(),
  })
  .openapi("ConnectorCallMetadata");

export const ConnectorCallResponseSchema = z
  .object({
    status: z.number().int(),
    headers: z.record(z.string(), z.string()),
    body: z.unknown(),
    latency_ms: z.number().int().nonnegative(),
    truncated: z.boolean(),
    body_byte_count: z.number().int().nonnegative(),
    raw_ref: z.string().optional(),
    health: z.enum([
      "ok",
      "auth_failed",
      "endpoint_gone",
      "deprecated",
      "not_found",
      "rate_limited",
      "degraded",
    ]),
    health_suggestion: z.string().optional(),
    next_best_actions: z.array(z.string()).optional(),
    metadata: ConnectorCallMetadataSchema,
  })
  .openapi("ConnectorCallResponse");
