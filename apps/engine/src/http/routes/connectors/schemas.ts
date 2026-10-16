import { z } from "@hono/zod-openapi";
import { CatalogSourceSchema } from "../../../api/catalog-metadata.ts";
import { ConnectionSummarySchema } from "../../../api/connection-schemas.ts";
import {
  ConnectorTemplateSourceEnum,
  type ConnectorView,
  connectorSignIn,
  effectiveConnectorHealth,
  OperatorQuirksSchema,
  resolveConnectorOAuthConfig,
  toPublicConnector,
} from "../../../connectors/index.ts";
import type { OAuth2ClientConfig } from "../../../credentials/index.ts";
import type { Db } from "../../../db/client.ts";
import { BadRequestError } from "../../errors.ts";

export const CredentialSummarySchema = z
  .object({
    id: z.string(),
    mode: z.string(),
    environment: z.string(),
    has_oauth_refresh: z.boolean(),
    granted_scopes: z.string().nullable(),
    oauth2_expires_at: z.string().datetime().nullable(),
    connection: ConnectionSummarySchema.nullable(),
    created_at: z.string(),
  })
  .openapi("CredentialSummary");

export const ConnectorHealthStateEnum = z
  .enum(["ok", "degraded", "needs_update", "needs_reauth"])
  .openapi("ConnectorHealthState");

export const ConnectorSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    slug: z.string(),
    display_name: z.string(),
    description: z.string().nullable(),
    description_source: CatalogSourceSchema,
    category: z
      .string()
      .describe(
        "The catalog block this connector belongs to, shared with workflows, knowledge sources, skills and files; `other` until one is assigned.",
      ),
    category_source: CatalogSourceSchema,
    driver: z.string(),
    environment: z.string(),
    auth_type: z.string(),
    base_url: z.string().nullable(),
    dsn: z.string().nullable(),
    config: z.record(z.string(), z.unknown()),
    operator_quirks: OperatorQuirksSchema,
    template_slug: z.string().nullable(),
    template_name: z.string().nullable(),
    template_source: ConnectorTemplateSourceEnum.nullable(),
    template_version: z.number().int().nullable(),
    template_snapshot: z.record(z.string(), z.unknown()).nullable(),
    self_description: z
      .object({
        links: z
          .array(
            z.object({
              kind: z.enum(["llms_txt", "llms_full", "openapi", "graphql"]),
              url: z.string(),
              source: z.enum(["discovery", "self_healing", "manual"]),
              discovered_at: z.string(),
            }),
          )
          .optional(),
      })
      .optional(),
    enabled: z.boolean(),
    last_error: z.string().nullable(),
    health_state: ConnectorHealthStateEnum,
    health_reason: z.string().nullable(),
    health_error_code: z.string().nullable(),
    circuit_state: z.enum(["closed", "open", "half-open"]),
    circuit_opened_at: z.string().datetime().nullable(),
    circuit_failure_count: z.number().int().nonnegative(),
    needs_reauth: z.boolean(),
    auth_failed_at: z.string().datetime().nullable(),
    auth_failed_reason: z.string().nullable(),
    sign_in: z
      .object({
        kind: z.enum(["oauth", "mcp"]),
        start: z.string(),
      })
      .nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    last_tested_at: z
      .string()
      .datetime()
      .nullable()
      .describe(
        "Last recorded explicit connector probe, successful or failed; null when no retained evidence exists.",
      ),
    tools_count: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        "Tool count from the most recent retained successful MCP manifest observation; null when unknown.",
      ),
    credentials: z.array(CredentialSummarySchema).optional(),
  })
  .openapi("Connector");

export const ConnectorListResponse = z
  .object({
    items: z.array(ConnectorSchema),
    total: z.number().int().nonnegative(),
    categories: z.array(z.object({ category: z.string(), count: z.number().int().nonnegative() })),
  })
  .openapi("ConnectorListResponse");

export const ProbeErrorCodeEnum = z
  .enum([
    "credential_missing",
    "credential_invalid",
    "credential_expired",
    "credential_unverified",
    "scope_insufficient",
    "remote_api_disabled",
    "remote_resource_not_found",
    "connector_disabled",
    "unknown_upstream_error",
  ])
  .openapi("ProbeErrorCode");

export const ProbeResultSchema = z
  .object({
    ok: z.boolean(),
    latency_ms: z.number(),
    status: z.number().optional(),
    detail: z.string().optional(),
    error_code: ProbeErrorCodeEnum.optional(),
    provider_action_url: z.string().optional(),
    warning_only: z.boolean().optional(),
    warnings: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
    partial_grant: z.union([z.boolean(), z.literal("unknown")]).optional(),
    granted_scopes: z.array(z.string()).optional(),
    expected_scopes: z.array(z.string()).optional(),
    missing_scopes: z.array(z.string()).optional(),
    partial_grant_note: z.string().optional(),
  })
  .openapi("ConnectorProbeResult");

export const CredentialBody = z
  .object({
    mode: z.enum(["none", "header", "query", "bearer", "basic", "aws_sigv4", "connection"]),
    connection_id: z.string().uuid().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.string()).optional(),
    token: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    access_key_id: z.string().optional(),
    secret_access_key: z.string().optional(),
    session_token: z.string().optional(),
  })
  .openapi("CredentialBody");

export const OAuthStartResponse = z
  .object({
    authorization_url: z.string(),
    state: z.string(),
  })
  .openapi("OAuthStartResponse");

export const OAuthCallbackQuery = z
  .object({
    state: z.string(),
    code: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .openapi("OAuthCallbackQuery");

export function serialize(view: ConnectorView) {
  const c = toPublicConnector(view);
  return {
    id: c.id,
    tenant_id: c.tenant_id,
    slug: c.slug,
    display_name: c.display_name,
    description: c.description,
    description_source: c.description_source,
    category: c.category,
    category_source: c.category_source,
    driver: c.driver,
    environment: c.environment,
    auth_type: c.auth_type,
    base_url: c.base_url,
    dsn: c.dsn,
    config: c.config,
    operator_quirks: c.operator_quirks,
    template_slug: c.template_slug,
    template_name: c.template_name,
    template_source: c.template_source,
    template_version: c.template_version,
    template_snapshot: c.template_snapshot,
    self_description: c.self_description,
    enabled: c.enabled,
    last_error: c.last_error,
    health_state: effectiveConnectorHealth(c),
    health_reason: c.health_reason,
    health_error_code: c.health_error_code,
    circuit_state: c.circuit_state,
    circuit_opened_at: c.circuit_opened_at?.toISOString() ?? null,
    circuit_failure_count: c.circuit_failure_count,
    needs_reauth: c.needs_reauth,
    auth_failed_at: c.auth_failed_at?.toISOString() ?? null,
    auth_failed_reason: c.auth_failed_reason,
    sign_in: connectorSignIn(c),
    created_at: c.created_at.toISOString(),
    updated_at: c.updated_at.toISOString(),
    last_tested_at: null as string | null,
    tools_count: null as number | null,
  };
}

export async function connectorOauthCfg(
  db: Db,
  tenant_id: string,
  c: ConnectorView,
): Promise<OAuth2ClientConfig> {
  const cfg = await resolveConnectorOAuthConfig(db, tenant_id, c);
  if (!cfg) {
    throw new BadRequestError("connector is missing oauth2 config (issuer_url + client_id)");
  }
  return cfg;
}
