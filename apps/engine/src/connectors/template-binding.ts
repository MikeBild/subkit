import { isDeepStrictEqual } from "node:util";
import type { OAuth2ClientConfig } from "../credentials/oauth2/types.ts";
import { getOAuth2ClientCredential } from "../credentials/service.ts";
import type { Executor } from "../db/client.ts";
import { getTemplateOAuthCredentials } from "./template-credentials.ts";
import { parseTemplateSnapshot } from "./template-resolver.ts";
import { getBuiltinTemplate, loadBuiltinTemplates, type ProbeDiagnostics } from "./templates.ts";
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

export interface TemplateSignedJwtPolicyIssue {
  field: "config.signed_jwt";
  message: string;
}

function signedJwtBlock(config: ConnectorConfig): Record<string, unknown> | null {
  const value = config.signed_jwt;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

export function validateTemplateSignedJwtPolicy(
  connector: Pick<ConnectorView, "auth_type" | "config" | "template_snapshot">,
): TemplateSignedJwtPolicyIssue | null {
  if (connector.auth_type !== "signed_jwt") return null;
  const template = getConnectorTemplateSnapshot(connector);
  const policy = template?.signed_jwt;
  if (!policy) return null;
  const config = signedJwtBlock(connectorConfig(connector));
  if (!config) {
    return {
      field: "config.signed_jwt",
      message: "the bound connector template requires a signed_jwt policy",
    };
  }
  for (const key of ["algorithm", "audience", "claims", "ttl_seconds"] as const) {
    if (!sameJson(config[key], policy[key])) {
      return {
        field: "config.signed_jwt",
        message: `the bound connector template fixes signed_jwt.${key}; clear or replace the template binding before changing it`,
      };
    }
  }
  return null;
}

export function getConnectorProbeEndpoint(
  connector: Pick<ConnectorView, "config" | "template_snapshot"> & {
    template_slug?: string | null;
  },
) {
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

export function serviceHostMatches(pattern: string, host: string): boolean {
  const [prefix = "", suffix = ""] = pattern.split("{api}");
  const label = host.slice(prefix.length, host.length - suffix.length);
  return (
    host.length > prefix.length + suffix.length &&
    host.startsWith(prefix) &&
    host.endsWith(suffix) &&
    /^[a-z0-9-]+$/.test(label)
  );
}

function baseUrlHostname(baseUrl: unknown): string | null {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return null;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function getConnectorProbeDiagnostics(
  connector: Pick<ConnectorView, "template_snapshot"> & {
    template_slug?: string | null;
    base_url?: string | null;
  },
): ProbeDiagnostics | null {
  const fromSnapshot = getConnectorTemplateSnapshot(connector)?.probe_diagnostics;
  if (fromSnapshot != null) return fromSnapshot;
  const fromSlug = connector.template_slug
    ? getBuiltinTemplate(connector.template_slug)?.probe_diagnostics
    : null;
  if (fromSlug != null) return fromSlug;
  const host = baseUrlHostname(connector.base_url);
  if (!host) return null;
  return (
    loadBuiltinTemplates().find((template) => {
      const pattern = template.probe_diagnostics?.remote_api_disabled?.service_host;
      return pattern !== undefined && serviceHostMatches(pattern, host);
    })?.probe_diagnostics ?? null
  );
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

export function connectorOAuthGrantType(
  connector: Pick<ConnectorView, "config" | "template_snapshot">,
): string | null {
  return (
    nonEmptyString(configOAuthBlock(connectorConfig(connector)).grant_type) ??
    nonEmptyString(getConnectorTemplateSnapshot(connector)?.oauth?.grant_type)
  );
}

export type ConnectorOAuthConfigResolution =
  | { ok: true; config: OAuth2ClientConfig }
  | { ok: false; missing: "issuer_url" | "client_id" | "template_oauth_credentials" };

export async function resolveConnectorOAuthConfig(
  db: Executor,
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
  db: Executor,
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
  const rawBuffer = (o as { refresh_buffer_ms?: unknown }).refresh_buffer_ms;
  if (typeof rawBuffer === "number" && Number.isFinite(rawBuffer) && rawBuffer > 0) {
    out.refresh_buffer_ms = rawBuffer;
  }
  const oExt = o as {
    token_request_body_mapping?: unknown;
    token_response_format?: unknown;
    token_response_ttl_ms?: unknown;
  };
  if (
    oExt.token_request_body_mapping &&
    typeof oExt.token_request_body_mapping === "object" &&
    !Array.isArray(oExt.token_request_body_mapping)
  ) {
    out.token_request_body_mapping = oExt.token_request_body_mapping as Record<string, string>;
  } else if (out.grant_type === "client_credentials_json" && out.client_id) {
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
