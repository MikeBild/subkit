import type { OAuth2ClientConfig } from "../credentials/oauth2/types.ts";
import { getOAuth2ClientCredential } from "../credentials/service.ts";
import type { Db } from "../db/client.ts";
import { getTemplateOAuthCredentials } from "./template-credentials.ts";
import { parseTemplateSnapshot } from "./template-resolver.ts";
import { getBuiltinTemplate } from "./templates.ts";
import type { ConnectorView } from "./types.ts";

type ConnectorConfig = Record<string, unknown>;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function connectorConfig(connector: Pick<ConnectorView, "config">): ConnectorConfig {
  return (connector.config ?? {}) as ConnectorConfig;
}

export function getConnectorTemplateSnapshot(connector: Pick<ConnectorView, "template_snapshot">) {
  return parseTemplateSnapshot(connector.template_snapshot);
}

export function getConnectorProbeEndpoint(
  connector: Pick<ConnectorView, "config" | "template_snapshot"> & {
    template_slug?: string | null;
  },
) {
  // Resolve the authenticated health/identity endpoint in precedence order, so
  // a probe (operator-initiated or the proactive re-auth scan) hits an endpoint
  // that actually exercises the credential rather than the public base root.
  //
  // An explicit per-connector value wins — INCLUDING an explicit `null`, which
  // is the operator's "do not probe" opt-out (key present, value null). Only
  // when the connector config declares nothing (key absent) do we fall back to
  // the captured template snapshot, then the LIVE builtin template — so a
  // connector created before its template declared a probe endpoint still
  // resolves one (the snapshot is a point-in-time copy that never back-fills).
  const cfg = connectorConfig(connector);
  if ("probe_endpoint" in cfg) return cfg.probe_endpoint ?? null;
  const fromSnapshot = getConnectorTemplateSnapshot(connector)?.probe_endpoint;
  if (fromSnapshot != null) return fromSnapshot;
  if (connector.template_slug) {
    const fromBuiltin = getBuiltinTemplate(connector.template_slug)?.probe_endpoint;
    if (fromBuiltin != null) return fromBuiltin;
  }
  return null;
}

export function getConnectorCapabilities(
  connector: Pick<ConnectorView, "config" | "template_snapshot">,
) {
  const cfg = connectorConfig(connector);
  if (cfg.capabilities !== undefined) return cfg.capabilities;
  return getConnectorTemplateSnapshot(connector)?.capabilities ?? null;
}

function configOAuthBlock(cfg: ConnectorConfig): Record<string, unknown> {
  const block = cfg.oauth;
  if (block && typeof block === "object" && !Array.isArray(block)) {
    return block as Record<string, unknown>;
  }
  return {};
}

/**
 * The OAuth grant a connector declares: its own `config.oauth.grant_type`,
 * else the bound template's. Read without the database, so the connector
 * representation and the routes that start a sign-in answer the same way
 * (`connectorSignIn`).
 */
export function connectorOAuthGrantType(
  connector: Pick<ConnectorView, "config" | "template_snapshot">,
): string | null {
  return (
    nonEmptyString(configOAuthBlock(connectorConfig(connector)).grant_type) ??
    nonEmptyString(getConnectorTemplateSnapshot(connector)?.oauth?.grant_type)
  );
}

/**
 * Why an OAuth config could not be assembled. `template_oauth_credentials`
 * is the actionable one: the connector is bound to a template whose OAuth
 * block expects tenant-supplied client credentials, and none were ever
 * stored (`POST /v1/connector-templates/{slug}/oauth-credentials` /
 * `sk connector-templates set-oauth`).
 */
export type ConnectorOAuthConfigResolution =
  | { ok: true; config: OAuth2ClientConfig }
  | { ok: false; missing: "issuer_url" | "client_id" | "template_oauth_credentials" };

/**
 * Presence-only projection of `resolveConnectorOAuthConfigDetailed` for
 * callers that only ask "is OAuth configured?" (capability flags, refresh
 * worker). Throw sites that surface errors to an operator must use the
 * detailed form so the missing reason is never collapsed into a generic
 * message.
 */
export async function resolveConnectorOAuthConfig(
  db: Db,
  tenant_id: string,
  connector: Pick<
    ConnectorView,
    "id" | "config" | "environment" | "template_slug" | "template_snapshot"
  >,
): Promise<OAuth2ClientConfig | null> {
  const res = await resolveConnectorOAuthConfigDetailed(db, tenant_id, connector);
  return res.ok ? res.config : null;
}

export async function resolveConnectorOAuthConfigDetailed(
  db: Db,
  tenant_id: string,
  connector: Pick<
    ConnectorView,
    "id" | "config" | "environment" | "template_slug" | "template_snapshot"
  >,
): Promise<ConnectorOAuthConfigResolution> {
  const cfg = connectorConfig(connector);
  const o = configOAuthBlock(cfg);
  const snapshot = getConnectorTemplateSnapshot(connector);
  const templateOauth = snapshot?.oauth ?? null;
  const templateCreds = connector.template_slug
    ? await getTemplateOAuthCredentials(tenant_id, connector.template_slug, db)
    : null;

  // RFC 7591 dynamic registration: when the template opts in, the engine
  // issued the client_id + client_secret at oauth/start time and persisted
  // them in the `oauth2_client` credential slot. Read them here so the
  // confidential-client refresh path can authenticate against the token
  // endpoint. The slot is separate from the user-facing `oauth2` row so
  // the callback's `upsertCredential` does not overwrite the identity.
  const dynamicCred =
    templateOauth?.dynamic_registration === true
      ? await getOAuth2ClientCredential(tenant_id, connector.id, connector.environment, db)
      : null;

  const issuer_url = nonEmptyString(o.issuer_url) ?? nonEmptyString(templateOauth?.issuer_url);
  const client_id =
    nonEmptyString(dynamicCred?.client_id) ??
    nonEmptyString(o.client_id) ??
    nonEmptyString(templateCreds?.client_id) ??
    nonEmptyString(templateOauth?.client_id);
  if (!issuer_url) return { ok: false, missing: "issuer_url" };
  if (!client_id) {
    // Template-bound connector whose template declares OAuth but ships no
    // shared client_id, no dynamic registration, and the tenant never
    // stored its own client credentials — the actionable case.
    const missing =
      connector.template_slug && templateOauth && templateCreds === null
        ? "template_oauth_credentials"
        : "client_id";
    return { ok: false, missing };
  }

  const out: OAuth2ClientConfig = {
    issuer_url,
    client_id,
  };
  const client_secret =
    nonEmptyString(dynamicCred?.client_secret) ??
    nonEmptyString(o.client_secret) ??
    nonEmptyString(templateCreds?.client_secret);
  if (client_secret) out.client_secret = client_secret;
  const authorization_endpoint =
    nonEmptyString(o.authorization_endpoint) ??
    nonEmptyString(templateOauth?.authorization_endpoint);
  if (authorization_endpoint) out.authorization_endpoint = authorization_endpoint;
  const token_endpoint =
    nonEmptyString(o.token_endpoint) ?? nonEmptyString(templateOauth?.token_endpoint);
  if (token_endpoint) out.token_endpoint = token_endpoint;
  const scope = nonEmptyString(o.scope) ?? nonEmptyString(templateOauth?.scopes);
  if (scope) out.scope = scope;
  // `redirect_uri` is deliberately NOT read from the connector's config:
  // it is synthesized server-side at oauth/start time from the engine's
  // canonical public origin + `/v1/oauth/callback`. Before this rule the
  // LLM authored a redirect URI into config.oauth and almost always got
  // it wrong (http://, wrong path), triggering `redirect_uri_mismatch`
  // at the provider. See `apps/engine/src/credentials/oauth2/redirect-uri.ts`.
  const audience = nonEmptyString(o.audience);
  if (audience) out.audience = audience;
  if (o.use_pkce !== undefined) out.use_pkce = o.use_pkce !== false;
  else if (templateOauth) out.use_pkce = templateOauth.use_pkce;
  const token_auth_method =
    nonEmptyString(o.token_auth_method) ?? nonEmptyString(templateOauth?.token_auth_method);
  if (token_auth_method === "body" || token_auth_method === "basic_auth") {
    out.token_auth_method = token_auth_method;
  }
  const token_content_type =
    nonEmptyString(o.token_content_type) ?? nonEmptyString(templateOauth?.token_content_type);
  if (token_content_type === "form" || token_content_type === "json") {
    out.token_content_type = token_content_type;
  }
  const extra_token_headers = o.extra_token_headers;
  if (
    extra_token_headers &&
    typeof extra_token_headers === "object" &&
    !Array.isArray(extra_token_headers)
  ) {
    out.extra_token_headers = extra_token_headers as Record<string, string>;
  } else if (templateOauth && Object.keys(templateOauth.extra_headers).length > 0) {
    out.extra_token_headers = templateOauth.extra_headers;
  }
  // Grant type — drives which token-endpoint flow runs at mint /
  // refresh time. `cognito_user_password` switches the refresh-worker
  // to the AWS InitiateAuth path.
  const grant_type = connectorOAuthGrantType(connector);
  if (
    grant_type === "authorization_code" ||
    grant_type === "client_credentials" ||
    grant_type === "password" ||
    grant_type === "cognito_user_password" ||
    grant_type === "client_credentials_json"
  ) {
    out.grant_type = grant_type;
  }
  // Refresh-buffer override (G7): tenants whose IdP issues short-lived
  // tokens can shrink the staleness window via `oauth.refresh_buffer_ms`.
  // Defaults to 60s in the refresh worker when omitted.
  const rawBuffer = (o as { refresh_buffer_ms?: unknown }).refresh_buffer_ms;
  if (typeof rawBuffer === "number" && Number.isFinite(rawBuffer) && rawBuffer > 0) {
    out.refresh_buffer_ms = rawBuffer;
  }
  // client_credentials_json extension: body field mapping, response
  // format, and default TTL. Connector config wins over template defaults.
  const oExt = o as {
    token_request_body_mapping?: unknown;
    token_response_format?: unknown;
    token_response_ttl_ms?: unknown;
  };
  // token_request_body_mapping: explicit operator-supplied map wins, otherwise
  // synthesise from the resolved client_id + client_secret. The template declares
  // which body field names to use; the actual credential values come from config.oauth.
  if (
    oExt.token_request_body_mapping &&
    typeof oExt.token_request_body_mapping === "object" &&
    !Array.isArray(oExt.token_request_body_mapping)
  ) {
    out.token_request_body_mapping = oExt.token_request_body_mapping as Record<string, string>;
  } else if (out.grant_type === "client_credentials_json" && out.client_id) {
    // Auto-build the body mapping from the resolved client_id and client_secret.
    // This is the default path for connectors that store credentials in config.oauth.
    const mapping: Record<string, string> = { client_id: out.client_id };
    if (out.client_secret) mapping.client_secret = out.client_secret;
    out.token_request_body_mapping = mapping;
  }
  const resolvedResponseFormat =
    oExt.token_response_format === "raw" || oExt.token_response_format === "json"
      ? oExt.token_response_format
      : templateOauth?.token_response_format === "raw" ||
          templateOauth?.token_response_format === "json"
        ? templateOauth.token_response_format
        : undefined;
  if (resolvedResponseFormat) out.token_response_format = resolvedResponseFormat;
  const resolvedTtlMs =
    typeof oExt.token_response_ttl_ms === "number" &&
    Number.isFinite(oExt.token_response_ttl_ms) &&
    oExt.token_response_ttl_ms > 0
      ? oExt.token_response_ttl_ms
      : typeof templateOauth?.token_response_ttl_ms === "number" &&
          Number.isFinite(templateOauth.token_response_ttl_ms) &&
          templateOauth.token_response_ttl_ms > 0
        ? templateOauth.token_response_ttl_ms
        : undefined;
  if (resolvedTtlMs !== undefined) out.token_response_ttl_ms = resolvedTtlMs;
  return { ok: true, config: out };
}
