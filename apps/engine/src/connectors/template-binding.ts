import type { OAuth2ClientConfig } from "../credentials/oauth2/types.ts";
import type { Db } from "../db/client.ts";
import { getTemplateOAuthCredentials } from "./template-credentials.ts";
import { parseTemplateSnapshot } from "./template-resolver.ts";
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
  connector: Pick<ConnectorView, "config" | "template_snapshot">,
) {
  const cfg = connectorConfig(connector);
  if (cfg.probe_endpoint !== undefined) return cfg.probe_endpoint;
  return getConnectorTemplateSnapshot(connector)?.probe_endpoint ?? null;
}

export function getConnectorCapabilities(
  connector: Pick<ConnectorView, "config" | "template_snapshot">,
) {
  const cfg = connectorConfig(connector);
  if (cfg.capabilities !== undefined) return cfg.capabilities;
  return getConnectorTemplateSnapshot(connector)?.capabilities ?? null;
}

export async function resolveConnectorOAuthConfig(
  db: Db,
  tenant_id: string,
  connector: Pick<ConnectorView, "config" | "template_slug" | "template_snapshot">,
): Promise<OAuth2ClientConfig | null> {
  const cfg = connectorConfig(connector);
  const snapshot = getConnectorTemplateSnapshot(connector);
  const templateOauth = snapshot?.oauth ?? null;
  const templateCreds = connector.template_slug
    ? await getTemplateOAuthCredentials(tenant_id, connector.template_slug, db)
    : null;

  const issuer_url = nonEmptyString(cfg.issuer_url) ?? nonEmptyString(templateOauth?.issuer_url);
  const client_id =
    nonEmptyString(cfg.client_id) ??
    nonEmptyString(templateCreds?.client_id) ??
    nonEmptyString(templateOauth?.client_id);
  if (!issuer_url || !client_id) return null;

  const out: OAuth2ClientConfig = {
    issuer_url,
    client_id,
  };
  const client_secret =
    nonEmptyString(cfg.client_secret) ?? nonEmptyString(templateCreds?.client_secret);
  if (client_secret) out.client_secret = client_secret;
  const authorization_endpoint =
    nonEmptyString(cfg.authorization_endpoint) ??
    nonEmptyString(templateOauth?.authorization_endpoint);
  if (authorization_endpoint) out.authorization_endpoint = authorization_endpoint;
  const token_endpoint =
    nonEmptyString(cfg.token_endpoint) ?? nonEmptyString(templateOauth?.token_endpoint);
  if (token_endpoint) out.token_endpoint = token_endpoint;
  const scope = nonEmptyString(cfg.scope) ?? nonEmptyString(templateOauth?.scopes);
  if (scope) out.scope = scope;
  const redirect_uri = nonEmptyString(cfg.redirect_uri);
  if (redirect_uri) out.redirect_uri = redirect_uri;
  const audience = nonEmptyString(cfg.audience);
  if (audience) out.audience = audience;
  if (cfg.use_pkce !== undefined) out.use_pkce = cfg.use_pkce !== false;
  else if (templateOauth) out.use_pkce = templateOauth.use_pkce;
  const token_auth_method =
    nonEmptyString(cfg.token_auth_method) ?? nonEmptyString(templateOauth?.token_auth_method);
  if (token_auth_method === "body" || token_auth_method === "basic_auth") {
    out.token_auth_method = token_auth_method;
  }
  const token_content_type =
    nonEmptyString(cfg.token_content_type) ?? nonEmptyString(templateOauth?.token_content_type);
  if (token_content_type === "form" || token_content_type === "json") {
    out.token_content_type = token_content_type;
  }
  const extra_token_headers = cfg.extra_token_headers;
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
  const grant_type = nonEmptyString(cfg.grant_type) ?? nonEmptyString(templateOauth?.grant_type);
  if (
    grant_type === "authorization_code" ||
    grant_type === "client_credentials" ||
    grant_type === "password" ||
    grant_type === "cognito_user_password" ||
    grant_type === "jwt_bearer" ||
    grant_type === "device_code"
  ) {
    out.grant_type = grant_type;
  }
  return out;
}
