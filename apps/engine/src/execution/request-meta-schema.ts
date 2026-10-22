import { z } from "@hono/zod-openapi";

const RequestDigestSchema = z
  .object({
    header_keys: z.array(z.string()),
    query_keys: z.array(z.string()),
    body_kind: z.string(),
  })
  .openapi("RequestDigest");

const PaginationCheckpointSchema = z
  .object({
    page_idx: z.number().int().min(0),
    accumulated_count: z.number().int().min(0),
    signature: z.string(),
  })
  .openapi("PaginationCheckpoint");

const RequestPaginationSummarySchema = z
  .object({
    strategy: z.enum(["offset", "page", "cursor", "link"]),
    pages: z.number().int().min(0),
    items: z.number().int().min(0),
    duplicates_dropped: z.number().int().min(0),
    complete: z.boolean(),
    truncated: z.boolean(),
    limit: z.enum(["max_pages", "max_items", "max_bytes"]).nullable(),
  })
  .openapi("RequestPaginationSummary");

const ConnectorResolutionSummarySchema = z
  .object({
    step_key: z.string(),
    connector_id: z.string(),
    connector_slug: z.string(),
    driver: z.string(),
    requested_environment: z.enum(["dev", "prod"]),
    resolved_environment: z.enum(["dev", "prod"]),
    auth_method: z.enum([
      "none",
      "bearer",
      "header",
      "query",
      "basic",
      "oauth2_static",
      "oauth2_refreshed",
      "aws_sigv4",
      "token_mint_static",
      "token_mint_refreshed",
      "signed_jwt",
      "oauth2_client",
      "oauth2_private_key",
    ]),
    base_url: z.string().nullable().optional(),
  })
  .openapi("ConnectorResolutionSummary");

const HttpRequestMetaSchema = z
  .object({
    driver: z.literal("http"),
    method: z.string(),
    url: z.string().nullable(),
    status: z.number().int().optional(),
    bytes_in: z.number().int().optional(),
    bytes_out: z.number().int().nonnegative().optional(),
    idempotency_key: z.string().optional(),
    connector: ConnectorResolutionSummarySchema,
    digest: RequestDigestSchema.optional(),
    pages_fetched: z.number().int().min(0).optional(),
    resumed_from_page: z.number().int().min(0).optional(),
    resumed_accumulated_count: z.number().int().min(0).optional(),
    pagination_checkpoint: PaginationCheckpointSchema.optional(),
    pagination: RequestPaginationSummarySchema.optional(),
    unresolved_placeholders: z.array(z.string()).optional(),
    extras: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("HttpRequestMeta");

const GraphqlRequestMetaSchema = z
  .object({
    driver: z.literal("graphql"),
    method: z.string(),
    status: z.number().int(),
    connector: ConnectorResolutionSummarySchema,
    operation_name: z.string().optional(),
    pagination: RequestPaginationSummarySchema.optional(),
    extras: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("GraphqlRequestMeta");

const PostgresRequestMetaSchema = z
  .object({
    driver: z.literal("postgres"),
    query_preview: z.string(),
    row_count: z.number().int().nullable(),
    transaction: z.boolean(),
    cursor: z.boolean(),
    connector: ConnectorResolutionSummarySchema,
    row_count_per_statement: z.array(z.number().int().nullable()).optional(),
    extras: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("PostgresRequestMeta");

const S3RequestMetaSchema = z
  .object({
    driver: z.literal("s3"),
    method: z.string(),
    status: z.number().int().optional(),
    refused: z.literal(true).optional(),
    key: z.string().optional(),
    prefix: z.string().optional(),
    bytes_out: z.number().int().nonnegative().optional(),
    connector: ConnectorResolutionSummarySchema,
    extras: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("S3RequestMeta");

const McpRequestMetaSchema = z
  .object({
    driver: z.literal("mcp"),
    operation: z.string(),
    bytes_in: z.number().int().min(0),
    tool_name: z.string().optional(),
    connector: ConnectorResolutionSummarySchema,
    extras: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("McpRequestMeta");

const ConnectorlessRequestMetaSchema = z
  .object({
    driver: z.literal("connectorless"),
    method: z.string(),
    url: z.string().nullable(),
    status: z.number().int().optional(),
    bytes_in: z.number().int().optional(),
    bytes_out: z.number().int().nonnegative().optional(),
    idempotency_key: z.string().optional(),
    unresolved_placeholders: z.array(z.string()).optional(),
    digest: RequestDigestSchema.optional(),
    pages_fetched: z.number().int().min(0).optional(),
    resumed_from_page: z.number().int().min(0).optional(),
    resumed_accumulated_count: z.number().int().min(0).optional(),
    pagination_checkpoint: PaginationCheckpointSchema.optional(),
    pagination: RequestPaginationSummarySchema.optional(),
    extras: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("ConnectorlessRequestMeta");

const ErrorRequestMetaSchema = z
  .object({
    driver: z.literal("error"),
    method: z.string().optional(),
    url: z.string().nullable().optional(),
    unresolved_placeholders: z.array(z.string()).optional(),
    digest: RequestDigestSchema.optional(),
    extras: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("ErrorRequestMeta");

const SensitiveRequestMetaSchema = z
  .object({
    driver: z.literal("sensitive"),
    pagination: RequestPaginationSummarySchema,
    extras: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("SensitiveRequestMeta");

export const RequestMetaSchema = z
  .discriminatedUnion("driver", [
    HttpRequestMetaSchema,
    GraphqlRequestMetaSchema,
    PostgresRequestMetaSchema,
    S3RequestMetaSchema,
    McpRequestMetaSchema,
    ConnectorlessRequestMetaSchema,
    ErrorRequestMetaSchema,
    SensitiveRequestMetaSchema,
  ])
  .openapi("RequestMeta");
