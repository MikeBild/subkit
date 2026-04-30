// Template → Connector enrichment.
//
// When a caller instantiates a connector from a template (admin route, CLI,
// MCP tool, spec-import tool), we merge template defaults into the user-
// supplied draft non-destructively: user input always wins, the template
// fills empty slots. OAuth2 metadata from the template flows into the
// connector's `config` block where the OAuth2 client later reads it.
//
// The enrichment is stateless and has no side effects; it does not touch
// the database.

import type { ConnectorTemplate } from "./templates.ts";
import type { CreateConnectorInput, DriverName } from "./types.ts";

export interface ConnectorDraftForEnrichment {
  name?: string | undefined;
  slug?: string | undefined;
  driver?: DriverName | undefined;
  environment?: "dev" | "prod" | undefined;
  base_url?: string | null | undefined;
  dsn?: string | undefined;
  auth_type?: CreateConnectorInput["auth_type"] | undefined;
  config?: Record<string, unknown> | undefined;
  operator_notes?: string | null | undefined;
}

export interface EnrichmentOptions {
  /**
   * If the template declares `base_url_options`, selects the option whose
   * `environment` matches this value. When omitted, the first option (or
   * `template.base_url`) is used.
   */
  environment?: string;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
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
  // template.base_url may legitimately be null for per-tenant templates
  // (AppSync, GCP service accounts) — caller is expected to surface a
  // missing-URL prompt to the operator.
  return template.base_url;
}

/**
 * Merge a template's defaults into a connector draft. User-provided fields
 * always win. Returns a fresh `CreateConnectorInput`; the input is not
 * mutated.
 *
 * OAuth2, probe, pagination, capabilities, and credential-hint metadata
 * from the template are placed into the `config` block so drivers and the
 * LLM context have a single, predictable place to read them.
 */
export function enrichConnectorFromTemplate(
  draft: ConnectorDraftForEnrichment,
  template: ConnectorTemplate,
  opts?: EnrichmentOptions,
): CreateConnectorInput {
  const cfg: Record<string, unknown> = { ...(draft.config ?? {}) };

  // OAuth2 block from the template → config.oauth (non-destructive).
  // Only seeded for oauth2 connectors; bearer/header/basic/aws_sigv4/none
  // never carry oauth metadata, even if the matched template advertises
  // an oauth flow as one of its auth_options.
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

  // Runtime + authoring metadata.
  if (cfg.probe_endpoint === undefined) cfg.probe_endpoint = template.probe_endpoint;
  if (cfg.pagination_defaults === undefined) cfg.pagination_defaults = template.pagination_defaults;
  if (cfg.capabilities === undefined) cfg.capabilities = template.capabilities;
  if (cfg.credential_hints === undefined) cfg.credential_hints = template.credential_hints;

  const baseUrl = resolveBaseUrl(draft.base_url, template, opts);
  const result: CreateConnectorInput = {
    name: draft.name ?? template.name,
    slug: draft.slug ?? template.slug,
    driver: (draft.driver as DriverName | undefined) ?? template.driver,
    environment: draft.environment ?? "dev",
    // null → undefined so the optional field stays unset rather than
    // serialising to a literal `"base_url": null` in the draft.
    ...(baseUrl !== null ? { base_url: baseUrl } : {}),
    auth_type:
      (draft.auth_type as CreateConnectorInput["auth_type"] | undefined) ?? template.auth_type,
    config: cfg,
  };
  if (draft.dsn !== undefined) (result as CreateConnectorInput).dsn = draft.dsn;
  // Operator notes: user input wins; template's note seeds the empty
  // case. Templates carry endpoint-specific quirks (e.g. GitHub list-
  // repos `type` vs `visibility`/`affiliation` mutual exclusion) that
  // the LLM cannot infer from OpenAPI alone.
  if (draft.operator_notes !== undefined) {
    result.operator_notes = draft.operator_notes;
  } else if (template.operator_notes) {
    result.operator_notes = template.operator_notes;
  }
  return result;
}
