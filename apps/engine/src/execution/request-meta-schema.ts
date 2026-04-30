// Zod surface for the driver-discriminated RequestMeta union. Used
// by the OpenAPI route definitions so external clients see the same
// structure the engine produces. Mirrors the TS type in
// `execution/types.ts:RequestMeta` 1:1.
//
// External consumers can `.parse(meta)` and switch on `.driver` to
// narrow — same affordance the internal types give us.

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
    ]),
    tunnel_target: z.string().nullable().optional(),
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
    tunnel_target: z.string().nullable().optional(),
    idempotency_key: z.string().optional(),
    connector: ConnectorResolutionSummarySchema,
    digest: RequestDigestSchema.optional(),
    pages_fetched: z.number().int().min(0).optional(),
    resumed_from_page: z.number().int().min(0).optional(),
    resumed_accumulated_count: z.number().int().min(0).optional(),
    pagination_checkpoint: PaginationCheckpointSchema.optional(),
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
    status: z.number().int(),
    key: z.string().optional(),
    prefix: z.string().optional(),
    connector: ConnectorResolutionSummarySchema,
    extras: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("S3RequestMeta");

const ConnectorlessRequestMetaSchema = z
  .object({
    driver: z.literal("connectorless"),
    method: z.string(),
    url: z.string().nullable(),
    status: z.number().int().optional(),
    bytes_in: z.number().int().optional(),
    idempotency_key: z.string().optional(),
    unresolved_placeholders: z.array(z.string()).optional(),
    digest: RequestDigestSchema.optional(),
    pages_fetched: z.number().int().min(0).optional(),
    resumed_from_page: z.number().int().min(0).optional(),
    resumed_accumulated_count: z.number().int().min(0).optional(),
    pagination_checkpoint: PaginationCheckpointSchema.optional(),
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

export const RequestMetaSchema = z
  .discriminatedUnion("driver", [
    HttpRequestMetaSchema,
    GraphqlRequestMetaSchema,
    PostgresRequestMetaSchema,
    S3RequestMetaSchema,
    ConnectorlessRequestMetaSchema,
    ErrorRequestMetaSchema,
  ])
  .openapi("RequestMeta");
