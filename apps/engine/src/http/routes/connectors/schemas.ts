// Shared Zod schemas + helpers for the connectors REST surface. Every
// per-sub-resource module imports from here.

import { z } from "@hono/zod-openapi";
import {
  ConnectorTemplateSourceEnum,
  type ConnectorView,
  effectiveConnectorHealth,
  OperatorQuirksSchema,
  resolveConnectorOAuthConfig,
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
    created_at: z.string(),
  })
  .openapi("CredentialSummary");

// The four verdicts `effectiveConnectorHealth` can return, in the same
// precedence order it applies them. An enum rather than a bare string so a
// generated client branches on the states that exist.
export const ConnectorHealthStateEnum = z
  .enum(["ok", "degraded", "needs_update", "needs_reauth"])
  .openapi("ConnectorHealthState");

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
    // re-validate via `parseTemplateSnapshot`.
    template_snapshot: z.record(z.string(), z.unknown()).nullable(),
    // Fetchable self-description LINKS (llms.txt / llms-full / OpenAPI / GraphQL)
    // the connector publishes — links only, never the document bodies. Lets a
    // consumer (MCP client, authoring loop) fetch the connector's own docs on
    // demand. Discovered on create + refreshed by the scheduler.
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
    // Operator on/off switch. Present because `POST {id}/enable` and
    // `POST {id}/disable` return this schema — a flip the caller could not
    // then read back would make those routes report nothing.
    enabled: z.boolean(),
    // The ENGINE's account of the most recent failed interaction, formatted
    // `[<error_code>] <sentence>` — never text the remote authored. Nullable
    // rather than optional so a client can tell "nothing recorded" from
    // "field missing"; `apps/engine/src/http/routes/connectors/enablement.test.ts`
    // pins the read path on both the single GET and the list item.
    last_error: z.string().nullable(),
    // Why the engine is (or is not) using this connector. `enabled` answers
    // "did a human switch it off"; these three answer "and does the engine
    // consider it usable" — the half of that question the API could not
    // answer before. All three are engine-authored, so unlike a remote's
    // error body they are safe to publish.
    //
    // `health_state` is the RECONCILED verdict across health_state /
    // needs_reauth / circuit_state (`effectiveConnectorHealth`), the same
    // one `/v1/diagnostics/integrations` reports as `effective_health` — a
    // representation that showed the stored column while `needs_reauth` said
    // otherwise would put two answers in front of one operator.
    // `health_reason` and `health_error_code` are what the last transition
    // recorded (`auth_rejected`, `endpoint_removed`, `rate_limited`, …).
    health_state: ConnectorHealthStateEnum,
    health_reason: z.string().nullable(),
    health_error_code: z.string().nullable(),
    // Re-auth health. `needs_reauth` flips true when the connector's
    // credential goes stale (OAuth refresh revoked, API key rotated, login
    // lapsed) and stays unusable until a human reconnects it. The
    // provenance pair records the first failure that flipped the flag.
    needs_reauth: z.boolean(),
    auth_failed_at: z.string().datetime().nullable(),
    auth_failed_reason: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    // Redacted credential summaries — present on single-connector GET so
    // operators can confirm what's attached (and via `sk credentials list`).
    // NEVER carries secret material; the vault ciphertext stays server-side.
    credentials: z.array(CredentialSummarySchema).optional(),
  })
  .openapi("Connector");

// A connector AS IT APPEARS IN THE CATALOG. `category` mirrors the workflow
// list item so both catalogs group the same way on every surface; for a
// connector it is simply the driver (see `categoryOfConnector`).
export const ConnectorListItemSchema = ConnectorSchema.extend({
  category: z.string(),
}).openapi("ConnectorListItem");

export const ConnectorListResponse = z
  .object({
    items: z.array(ConnectorListItemSchema),
    /** Exact tenant-scoped count under the same filters (ignores limit/offset). */
    total: z.number().int().nonnegative(),
    /** Blocks present in `items`, in render order — mirrors the workflow list. */
    categories: z.array(z.object({ category: z.string(), count: z.number().int().nonnegative() })),
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
    // The engine never asked: an operator switched the connector off. The
    // only member that reports OUR state rather than the upstream's — see
    // `ProbeErrorCode` in connectors/drivers/index.ts.
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
    mode: z.enum(["none", "header", "query", "bearer", "basic", "aws_sigv4", "connection"]),
    // `connection` mode — the credential points at an outbound connection
    // (Cockpit "Verbindung wählen") and carries no pasted material at all.
    connection_id: z.string().uuid().optional(),
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
    self_description: c.self_description,
    enabled: c.enabled,
    last_error: c.last_error,
    health_state: effectiveConnectorHealth(c),
    health_reason: c.health_reason,
    health_error_code: c.health_error_code,
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
