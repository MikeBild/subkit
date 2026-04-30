// Cross-surface connector Zod schemas.
//
// These types are reflected by both the conversation tools (via
// `inputSchema`) and the public HTTP routes
// (`POST /v1/connectors/discover`, `POST /v1/connectors/{id}/call`).
// Keeping them here means a single Zod object owns the OpenAPI shape —
// generated SDKs, Scalar UI, and any Zod consumer all see the same
// envelope.
//
// Mirror the runtime types in `connectors/discovery/types.ts` and
// `connectors/services/call-connector.ts`. If those types change, this
// file must change with them — there is no implicit reflection.

import { z } from "@hono/zod-openapi";

// ---- Discovery -------------------------------------------------------------

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
    "mssql-introspect",
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

// ---- Connector call --------------------------------------------------------

const CallMethodEnum = z
  .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
  .openapi("ConnectorCallMethod");

/**
 * Flat schema mirroring the multi-driver shape used by the
 * `call_connector` conversation tool. Driver-specific fields are
 * optional at this level — the service helper validates the right
 * combination based on `connector.driver`.
 *
 * For the public HTTP route we only honour `http` and `graphql` paths
 * today (Postgres / SFTP / S3 are conversation-tool-only while the
 * Wave-2 multi-driver work stabilises). Calls with unsupported drivers
 * surface as `driver_not_supported_for_call_connector` (HTTP 422).
 */
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
    metadata: ConnectorCallMetadataSchema,
  })
  .openapi("ConnectorCallResponse");
