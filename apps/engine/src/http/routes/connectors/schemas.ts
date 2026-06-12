// Shared Zod schemas + helpers for the connectors REST surface. After
// the Phase 4 split (audit §4.4) every per-sub-resource module imports
// from here.

import { z } from "@hono/zod-openapi";
import {
  ConnectorTemplateSourceEnum,
  type ConnectorView,
  OperatorQuirksSchema,
  resolveConnectorOAuthConfig,
} from "../../../connectors/index.ts";
import type { OAuth2ClientConfig } from "../../../credentials/index.ts";
import type { Db } from "../../../db/client.ts";
import { BadRequestError } from "../../errors.ts";

export const ConnectorSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    slug: z.string(),
    display_name: z.string(),
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
    // Public surface deliberately stays `Record<string, unknown>` — the
    // internal `ConnectorTemplate` shape is allowed to evolve (new
    // optional fields, schema-version bumps) without breaking
    // OpenAPI clients pinned against this contract. The producer
    // (`buildTemplateBindingFields` in connectors/template-resolver.ts)
    // is internally typed; callers that need the narrower shape
    // re-validate via `parseTemplateSnapshot`. Per #147 review S4.
    template_snapshot: z.record(z.string(), z.unknown()).nullable(),
    // Re-auth health. `needs_reauth` flips true when the connector's
    // credential goes stale (OAuth refresh revoked, API key rotated, login
    // lapsed) and stays unusable until a human reconnects it. The
    // provenance pair records the first failure that flipped the flag.
    needs_reauth: z.boolean(),
    auth_failed_at: z.string().datetime().nullable(),
    auth_failed_reason: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("Connector");

export const ConnectorListResponse = z
  .object({
    items: z.array(ConnectorSchema),
    /** Exact tenant-scoped count under the same filters (ignores limit/offset). */
    total: z.number().int().nonnegative(),
  })
  .openapi("ConnectorListResponse");

// H1: full probe envelope shape, matching the conversation-tool
// `test_connector` result. REST + MCP + conversation surfaces now
// carry the same fields so OpenAPI clients can branch on the typed
// signals (error_code, partial_grant) without out-of-band knowledge.
export const ProbeErrorCodeEnum = z
  .enum([
    "credential_missing",
    "credential_invalid",
    "credential_expired",
    "scope_insufficient",
    "remote_api_disabled",
    "remote_resource_not_found",
    "unknown_upstream_error",
  ])
  .openapi("ProbeErrorCode");

export const ProbeResultSchema = z
  .object({
    ok: z.boolean(),
    latency_ms: z.number(),
    status: z.number().optional(),
    detail: z.string().optional(),
    // G10: typed failure classification + provider deep link.
    error_code: ProbeErrorCodeEnum.optional(),
    provider_action_url: z.string().optional(),
    // G6: OAuth scope diff. Present only for oauth2 connectors with
    // both expected and granted scopes known. `partial_grant` may
    // also take the literal "unknown" when the credential row predates
    // the 6.2.4 migration and never recorded a granted_scopes value
    // (H4) — lets the LLM tell "we know it's fine" from "we have no
    // data".
    partial_grant: z.union([z.boolean(), z.literal("unknown")]).optional(),
    granted_scopes: z.array(z.string()).optional(),
    expected_scopes: z.array(z.string()).optional(),
    missing_scopes: z.array(z.string()).optional(),
    partial_grant_note: z.string().optional(),
  })
  .openapi("ConnectorProbeResult");

export const CredentialBody = z
  .object({
    mode: z.enum(["none", "header", "query", "bearer", "basic", "aws_sigv4"]),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.string()).optional(),
    token: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    // aws_sigv4 mode — long-lived IAM keys + optional STS session token.
    // The credential service already supports this mode; the route's
    // request schema was the gap. The audit recorder writes
    // `metadata.mode = "aws_sigv4"` and the service's serialize path
    // reduces the value to a digest before persistence.
    access_key_id: z.string().optional(),
    secret_access_key: z.string().optional(),
    session_token: z.string().optional(),
  })
  .openapi("CredentialBody");

export const EndUserCredentialBody = z
  .object({
    enduser_ref: z.string(),
    combine_mode: z.enum(["merge", "replace"]),
    payload: z.record(z.string(), z.unknown()),
  })
  .openapi("EndUserCredentialBody");

export const OAuthStartResponse = z
  .object({
    authorization_url: z.string(),
    state: z.string(),
  })
  .openapi("OAuthStartResponse");

export const OAuthCallbackQuery = z
  .object({
    state: z.string(),
    // `code` is present on success, absent when the provider redirects
    // back with `?error=...`. The route renders a user-friendly HTML
    // page in either case — never a 400 JSON to a browser tab.
    code: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .openapi("OAuthCallbackQuery");

export function serialize(c: ConnectorView) {
  return {
    id: c.id,
    tenant_id: c.tenant_id,
    slug: c.slug,
    display_name: c.display_name,
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
    needs_reauth: c.needs_reauth,
    auth_failed_at: c.auth_failed_at?.toISOString() ?? null,
    auth_failed_reason: c.auth_failed_reason,
    created_at: c.created_at.toISOString(),
    updated_at: c.updated_at.toISOString(),
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
