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
): string {
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

  // OAuth2 block from the template → config (non-destructive).
  if (template.oauth) {
    const o = template.oauth;
    if (cfg.issuer_url === undefined) cfg.issuer_url = o.issuer_url;
    if (cfg.authorization_endpoint === undefined && o.authorization_endpoint) {
      cfg.authorization_endpoint = o.authorization_endpoint;
    }
    if (cfg.token_endpoint === undefined && o.token_endpoint) {
      cfg.token_endpoint = o.token_endpoint;
    }
    if (cfg.scope === undefined && o.scopes) cfg.scope = o.scopes;
    if (cfg.grant_type === undefined) cfg.grant_type = o.grant_type;
    if (cfg.token_auth_method === undefined) cfg.token_auth_method = o.token_auth_method;
    if (cfg.token_content_type === undefined) cfg.token_content_type = o.token_content_type;
    if (cfg.use_pkce === undefined) cfg.use_pkce = o.use_pkce;
    if (cfg.client_id === undefined && o.client_id !== null) cfg.client_id = o.client_id;
    if (cfg.extra_token_headers === undefined && Object.keys(o.extra_headers).length > 0) {
      cfg.extra_token_headers = { ...o.extra_headers };
    }
  }

  // Runtime + authoring metadata.
  if (cfg.probe_endpoint === undefined) cfg.probe_endpoint = template.probe_endpoint;
  if (cfg.pagination_defaults === undefined) cfg.pagination_defaults = template.pagination_defaults;
  if (cfg.capabilities === undefined) cfg.capabilities = template.capabilities;
  if (cfg.credential_hints === undefined) cfg.credential_hints = template.credential_hints;

  const result: CreateConnectorInput = {
    name: draft.name ?? template.name,
    slug: draft.slug ?? template.slug,
    driver: (draft.driver as DriverName | undefined) ?? template.driver,
    environment: draft.environment ?? "dev",
    base_url: resolveBaseUrl(draft.base_url, template, opts),
    auth_type:
      (draft.auth_type as CreateConnectorInput["auth_type"] | undefined) ?? template.auth_type,
    config: cfg,
  };
  if (draft.dsn !== undefined) (result as CreateConnectorInput).dsn = draft.dsn;
  if (draft.operator_notes !== undefined) result.operator_notes = draft.operator_notes;
  return result;
}
