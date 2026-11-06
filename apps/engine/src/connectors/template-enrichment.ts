import type { ConnectorTemplate } from "./templates.ts";
import {
  type CreateConnectorInput,
  type DriverName,
  OPERATOR_QUIRK_CATEGORIES,
  type OperatorQuirks,
} from "./types.ts";

interface ConnectorDraftForEnrichment {
  name?: string | undefined;
  slug?: string | undefined;
  driver?: DriverName | undefined;
  environment?: "dev" | "prod" | undefined;
  base_url?: string | null | undefined;
  dsn?: string | undefined;
  auth_type?: CreateConnectorInput["auth_type"] | undefined;
  config?: Record<string, unknown> | undefined;
  operator_quirks?: OperatorQuirks | undefined;
}

interface EnrichmentOptions {
  environment?: string;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function extractAwsRegionFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const m = host.match(/\.([a-z]{2}-[a-z]+-\d+)\.amazonaws\.com$/);
    if (m?.[1]) return m[1];
    const m2 = host.match(/\.([a-z]{2}-[a-z]+-\d+)\.api\.aws$/);
    if (m2?.[1]) return m2[1];
    return null;
  } catch {
    return null;
  }
}

function resolveBaseUrl(
  draftBaseUrl: string | null | undefined,
  template: ConnectorTemplate,
  opts: EnrichmentOptions | undefined,
): string | null {
  if (!isEmpty(draftBaseUrl)) return draftBaseUrl as string;
  const options = template.base_url_options;
  if (opts?.environment) {
    const match = options.find((o) => o.environment === opts.environment);
    if (match) return match.base_url;
  }
  const first = options[0];
  if (first) return first.base_url;
  return template.base_url;
}

function credentialHintsForAuthType(
  authType: CreateConnectorInput["auth_type"] | undefined,
  template: ConnectorTemplate,
): unknown[] | undefined {
  if (!authType || authType === template.auth_type) return template.credential_hints;
  switch (authType) {
    case "basic":
      return [
        { field: "username", label: "Username / email", secret: false, placeholder: "" },
        { field: "password", label: "Password / API token", secret: true, placeholder: "" },
      ];
    case "bearer":
      return [{ field: "token", label: "Bearer token", secret: true, placeholder: "" }];
    case "header":
      return [{ field: "value", label: "API key", secret: true, placeholder: "" }];
    case "aws_sigv4":
      return [
        { field: "access_key_id", label: "AWS Access Key ID", secret: false, placeholder: "" },
        {
          field: "secret_access_key",
          label: "AWS Secret Access Key",
          secret: true,
          placeholder: "",
        },
      ];
    case "none":
      return [];
    default:
      return template.credential_hints;
  }
}

export function enrichConnectorFromTemplate(
  draft: ConnectorDraftForEnrichment,
  template: ConnectorTemplate,
  opts?: EnrichmentOptions,
): CreateConnectorInput {
  const cfg: Record<string, unknown> = { ...(draft.config ?? {}) };

  if (draft.auth_type === "aws_sigv4") {
    if (cfg.aws_service === undefined && template.aws_service) {
      cfg.aws_service = template.aws_service;
    }
    if (cfg.aws_region === undefined) {
      const fromTemplate = template.aws_region;
      const baseUrl = resolveBaseUrl(draft.base_url, template, opts);
      const fromUrl = baseUrl ? extractAwsRegionFromUrl(baseUrl) : null;
      const region = fromTemplate ?? fromUrl;
      if (region) cfg.aws_region = region;
    }
  }

  if (template.oauth && draft.auth_type === "oauth2") {
    const t = template.oauth;
    const existing = (cfg.oauth as Record<string, unknown> | undefined) ?? {};
    const oauth: Record<string, unknown> = { ...existing };
    if (oauth.issuer_url === undefined) oauth.issuer_url = t.issuer_url;
    if (oauth.authorization_endpoint === undefined && t.authorization_endpoint) {
      oauth.authorization_endpoint = t.authorization_endpoint;
    }
    if (oauth.token_endpoint === undefined && t.token_endpoint) {
      oauth.token_endpoint = t.token_endpoint;
    }
    if (oauth.scope === undefined && t.scopes) oauth.scope = t.scopes;
    if (oauth.grant_type === undefined) oauth.grant_type = t.grant_type;
    if (oauth.token_auth_method === undefined) oauth.token_auth_method = t.token_auth_method;
    if (oauth.token_content_type === undefined) oauth.token_content_type = t.token_content_type;
    if (oauth.use_pkce === undefined) oauth.use_pkce = t.use_pkce;
    if (oauth.client_id === undefined && t.client_id !== null) oauth.client_id = t.client_id;
    if (oauth.extra_token_headers === undefined && Object.keys(t.extra_headers).length > 0) {
      oauth.extra_token_headers = { ...t.extra_headers };
    }
    cfg.oauth = oauth;
  }

  if (template.signed_jwt && (draft.auth_type ?? template.auth_type) === "signed_jwt") {
    const existing = (cfg.signed_jwt as Record<string, unknown> | undefined) ?? {};
    cfg.signed_jwt = {
      ...existing,
      ...template.signed_jwt,
    };
  }

  if (cfg.probe_endpoint === undefined && template.probe_endpoint != null) {
    cfg.probe_endpoint = template.probe_endpoint;
  }
  if (cfg.pagination_defaults === undefined) cfg.pagination_defaults = template.pagination_defaults;
  if (cfg.capabilities === undefined) cfg.capabilities = template.capabilities;
  if (cfg.credential_hints === undefined) {
    cfg.credential_hints = credentialHintsForAuthType(
      draft.auth_type ?? template.auth_type,
      template,
    );
  }

  const baseUrl = resolveBaseUrl(draft.base_url, template, opts);
  const result: CreateConnectorInput = {
    name: draft.name ?? template.name,
    slug: draft.slug ?? template.slug,
    driver: (draft.driver as DriverName | undefined) ?? template.driver,
    environment: draft.environment ?? "dev",
    ...(baseUrl !== null ? { base_url: baseUrl } : {}),
    auth_type:
      (draft.auth_type as CreateConnectorInput["auth_type"] | undefined) ?? template.auth_type,
    config: cfg,
  };
  if (draft.dsn !== undefined) (result as CreateConnectorInput).dsn = draft.dsn;
  const merged: OperatorQuirks = { ...(template.operator_quirks ?? {}) };
  if (draft.operator_quirks) {
    for (const cat of OPERATOR_QUIRK_CATEGORIES) {
      const v = draft.operator_quirks[cat];
      if (v !== undefined) merged[cat] = v;
    }
  }
  if (Object.keys(merged).length > 0) result.operator_quirks = merged;
  return result;
}
