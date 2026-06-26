// ConnectorDef — the zod schema that validates inbound create/update
// payloads for the connectors API. Connectors are tenant-scoped and
// environment-scoped (dev/prod); the composite unique key is
// (tenant_id, slug, environment).
//
// `driver` picks the runtime transport:
//   - "http"     : HTTP/REST driver. Needs base_url.
//   - "postgres" : postgres driver. Needs dsn.
//
// `auth_type` tells the credential layer how to apply the secret.
// `config` carries driver- and auth-specific options (e.g. header names
// for a "header" auth, oauth2 issuer URL, etc.).

import { z } from "@hono/zod-openapi";

export const DriverEnum = z.enum(["http", "postgres", "s3", "graphql"]);
export type DriverName = z.infer<typeof DriverEnum>;

export const EnvironmentEnum = z.enum(["dev", "prod"]);
export type Environment = z.infer<typeof EnvironmentEnum>;
export const ConnectorTemplateSourceEnum = z.enum(["builtin", "tenant"]);
export type ConnectorTemplateSource = z.infer<typeof ConnectorTemplateSourceEnum>;

export const AuthTypeEnum = z.enum([
  "none",
  "header",
  "query",
  "bearer",
  "basic",
  "oauth2",
  "aws_sigv4",
]);
export type AuthType = z.infer<typeof AuthTypeEnum>;

// Categorized replacement for the legacy free-form `operator_notes` blob.
//
// The previous shape (`text(4000)`) bloated tokens (4 KB × N connectors per
// turn) and surfaced auth quirks while authoring transforms. Splitting into
// six categories lets the context assembler pick only the relevant slice
// per turn — `auth + pagination + rate_limit` for request authoring,
// `schema` for transforms, `error_handling` after a failed envelope.
//
// Each slot caps at 2K characters. The whole block lives in the stable
// cached prompt section; per-turn category selection is a string concat
// outside the cached region so the cache key stays stable across swaps.
export const OperatorQuirksSchema = z
  .object({
    auth: z.string().max(2_000).optional(),
    pagination: z.string().max(2_000).optional(),
    rate_limit: z.string().max(2_000).optional(),
    schema: z.string().max(2_000).optional(),
    error_handling: z.string().max(2_000).optional(),
    general: z.string().max(2_000).optional(),
  })
  .openapi("OperatorQuirks");
export type OperatorQuirks = z.infer<typeof OperatorQuirksSchema>;

export const OPERATOR_QUIRK_CATEGORIES = [
  "auth",
  "pagination",
  "rate_limit",
  "schema",
  "error_handling",
  "general",
] as const;
export type OperatorQuirkCategory = (typeof OPERATOR_QUIRK_CATEGORIES)[number];

export const HeaderAuthConfigSchema = z
  .object({
    auth_type: z.literal("header"),
    // Extra headers to apply. The actual secret values come from the
    // credential row — `config.header_names` just lists which headers
    // the credential is expected to populate. Fully static headers on
    // the connector (non-secret) can go in `static_headers`.
    static_headers: z.record(z.string(), z.string()).optional(),
  })
  .openapi("HeaderAuthConfig");

export const QueryAuthConfigSchema = z
  .object({
    auth_type: z.literal("query"),
    static_query: z.record(z.string(), z.string()).optional(),
  })
  .openapi("QueryAuthConfig");

export const BearerAuthConfigSchema = z
  .object({ auth_type: z.literal("bearer") })
  .openapi("BearerAuthConfig");

export const BasicAuthConfigSchema = z
  .object({ auth_type: z.literal("basic") })
  .openapi("BasicAuthConfig");

export const OAuth2AuthConfigSchema = z
  .object({
    auth_type: z.literal("oauth2"),
    issuer_url: z.string().url(),
    authorization_endpoint: z.string().url().optional(),
    token_endpoint: z.string().url().optional(),
    client_id: z.string().nullable(),
    client_secret: z.string().optional(),
    grant_type: z.enum([
      "authorization_code",
      "client_credentials",
      "password",
      "cognito_user_password",
      "client_credentials_json",
    ]),
    token_auth_method: z.enum(["body", "basic_auth"]).default("body"),
    token_content_type: z.enum(["form", "json"]).default("form"),
    use_pkce: z.boolean().default(true),
    extra_token_headers: z.record(z.string(), z.string()).default({}),
    scope: z.string().optional(),
    // redirect_uri removed: engine-synthesized from server.public_base_url +
    // /v1/oauth/callback. See apps/engine/src/credentials/oauth2/redirect-uri.ts.
    audience: z.string().optional(),
    /** AWS Cognito-specific config (only meaningful when
     *  `grant_type === "cognito_user_password"`). */
    aws_region: z.string().optional(),
    cognito_username: z.string().optional(),
    cognito_use_access_token: z.boolean().optional(),
  })
  .openapi("OAuth2AuthConfig");

export const AwsSigV4AuthConfigSchema = z
  .object({
    auth_type: z.literal("aws_sigv4"),
    /** AWS region — e.g. `eu-central-1`. Defaults to `us-east-1`. */
    aws_region: z.string().optional(),
    /** AWS service short-name — e.g. `appsync`, `execute-api`,
     *  `dynamodb`, `s3`. **Required** — sigv4 canonical request needs it. */
    aws_service: z.string().min(1),
  })
  .openapi("AwsSigV4AuthConfig");

export const NoneAuthConfigSchema = z
  .object({ auth_type: z.literal("none") })
  .openapi("NoneAuthConfig");

export const AuthConfigSchema = z
  .discriminatedUnion("auth_type", [
    NoneAuthConfigSchema,
    HeaderAuthConfigSchema,
    QueryAuthConfigSchema,
    BearerAuthConfigSchema,
    BasicAuthConfigSchema,
    OAuth2AuthConfigSchema,
    AwsSigV4AuthConfigSchema,
  ])
  .openapi("AuthConfig");

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

// OAuth2-enrichment block. Templates seed connector.config.oauth with
// the bits the OAuth2 client needs (issuer + endpoints + grant + auth
// method). User-supplied connector overrides win in template-binding.ts
// when assembling the OAuth2ClientConfig at mint / refresh time.
const OAuthEnrichmentSchema = z
  .object({
    issuer_url: z.string().optional(),
    authorization_endpoint: z.string().optional(),
    token_endpoint: z.string().optional(),
    scope: z.string().optional(),
    grant_type: z
      .enum([
        "authorization_code",
        "client_credentials",
        "password",
        "cognito_user_password",
        "client_credentials_json",
      ])
      .optional(),
    token_auth_method: z.enum(["body", "basic_auth"]).optional(),
    token_content_type: z.enum(["form", "json"]).optional(),
    use_pkce: z.boolean().optional(),
    extra_token_headers: z.record(z.string(), z.string()).optional(),
    client_id: z.string().nullable().optional(),
    client_secret: z.string().optional(),
    audience: z.string().optional(),
    // redirect_uri removed: engine-synthesized — see OAuth2AuthConfigSchema above.
    // client_credentials_json extension fields.
    token_request_body_mapping: z.record(z.string(), z.string()).optional(),
    token_response_format: z.enum(["raw", "json"]).optional(),
    token_response_ttl_ms: z.number().positive().optional(),
    // refresh_buffer_ms is readable by template-binding even though it
    // lives on the OAuth2ClientConfig — allow it here so operators can
    // override the staleness window per-connector via config.oauth.
    refresh_buffer_ms: z.number().positive().optional(),
  })
  .strict();

export const HttpConnectorConfig = z
  .object({
    static_headers: z.record(z.string(), z.string()).optional(),
    static_query: z.record(z.string(), z.string()).optional(),
    timeout_ms: z.number().positive().max(300_000).optional(),
    max_retries: z.number().int().min(0).max(5).optional(),
    follow_redirects: z.boolean().default(true).optional(),
    // AWS SigV4 driver inputs. Both are template-seeded for every aws_sigv4
    // connector at draft mint time (see template-enrichment.ts) and read by
    // drivers/http.ts. `aws_region` is also accepted on the cognito_user_password
    // credential save path (save-connector.ts).
    aws_region: z.string().optional(),
    aws_service: z.string().optional(),
    // Template-enrichment metadata — drivers and the LLM context may read
    // these but they are not validated here beyond shape. The template
    // schema (connectors/templates.ts) is the authoritative source.
    probe_endpoint: z.record(z.string(), z.unknown()).nullable().optional(),
    pagination_defaults: z.record(z.string(), z.unknown()).nullable().optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    credential_hints: z.array(z.record(z.string(), z.unknown())).optional(),
    imported_sample_endpoints: z.array(z.record(z.string(), z.unknown())).optional(),
    imported_source: z.string().optional(),
    oauth: OAuthEnrichmentSchema.optional(),
  })
  .strict();

export type HttpConnectorConfigType = z.infer<typeof HttpConnectorConfig>;

export const CreateConnectorSchema = z
  .object({
    name: z.string().min(1),
    slug: z.string().min(1).optional(),
    driver: DriverEnum,
    environment: EnvironmentEnum.default("dev"),
    base_url: z.string().url().optional(),
    dsn: z.string().optional(),
    auth_type: AuthTypeEnum.default("none"),
    config: z.record(z.string(), z.unknown()).optional(),
    // Categorized operator quirks surfaced to the LLM whenever this
    // connector is in scope for a conversation turn. The context
    // assembler picks only the categories relevant to the current turn
    // (auth+pagination+rate_limit on request authoring, schema on
    // transforms, error_handling after a failure envelope).
    operator_quirks: OperatorQuirksSchema.optional(),
    template_slug: z.string().min(1).optional(),
    template_source: ConnectorTemplateSourceEnum.optional(),
    template_base_url_environment: z.string().min(1).optional(),
  })
  .openapi("CreateConnectorBody");

export type CreateConnectorInput = z.infer<typeof CreateConnectorSchema>;

export const UpdateConnectorSchema = z
  .object({
    name: z.string().min(1).optional(),
    base_url: z.string().url().optional(),
    dsn: z.string().optional(),
    auth_type: AuthTypeEnum.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    // Omitted leaves quirks untouched. Pass an empty object to clear them.
    operator_quirks: OperatorQuirksSchema.optional(),
    template_slug: z.string().min(1).optional(),
    template_source: ConnectorTemplateSourceEnum.optional(),
    template_base_url_environment: z.string().min(1).optional(),
    clear_template_binding: z.boolean().optional(),
  })
  .openapi("UpdateConnectorBody");

export type UpdateConnectorInput = z.infer<typeof UpdateConnectorSchema>;

export interface ConnectorView {
  id: string;
  tenant_id: string;
  slug: string;
  display_name: string;
  driver: DriverName;
  environment: Environment;
  auth_type: AuthType;
  base_url: string | null;
  dsn: string | null;
  config: Record<string, unknown>;
  operator_quirks: OperatorQuirks;
  template_slug: string | null;
  template_name: string | null;
  template_source: ConnectorTemplateSource | null;
  template_version: number | null;
  template_snapshot: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  circuit_state: "closed" | "open" | "half-open";
  circuit_opened_at: Date | null;
  circuit_failure_count: number;
  circuit_threshold: number;
  circuit_reset_ms: number;
  needs_reauth: boolean;
  auth_failed_at: Date | null;
  auth_failed_reason: string | null;
  /** Rolled-up health (ok | degraded | needs_update | needs_reauth) — see
   *  connectors/health-state.ts. Snapshot at read time; the dispatcher uses
   *  it as an in-memory guard so steady-state requests skip the no-op
   *  health UPDATE. */
  health_state: string;
  health_reason: string | null;
  health_error_code: string | null;
  sunset_at: Date | null;
  successor_uri: string | null;
}
