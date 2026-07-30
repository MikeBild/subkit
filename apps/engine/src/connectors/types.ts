// ConnectorDef — the zod schema that validates inbound create/update
// payloads for the connectors API. Connectors are tenant-scoped and
// environment-scoped (dev/prod); the composite unique key is
// (tenant_id, slug, environment).
//
// `driver` picks the runtime transport:
//   - "http"     : HTTP/REST driver. Needs base_url.
//   - "graphql"  : GraphQL over HTTP. Needs base_url (the single endpoint).
//   - "s3"       : S3-compatible object store. Needs config.bucket.
//   - "postgres" : postgres driver. Needs dsn.
//   - "mcp"      : remote Model Context Protocol server over streamable
//                  HTTP. Needs base_url. Unlike the four above it is not
//                  stateless per request — see connectors/drivers/mcp.ts.
//
// `auth_type` tells the credential layer how to apply the secret.
// `config` carries driver- and auth-specific options (e.g. header names
// for a "header" auth, oauth2 issuer URL, etc.).

import { z } from "@hono/zod-openapi";

export const DriverEnum = z.enum(["http", "postgres", "s3", "graphql", "mcp"]);
export type DriverName = z.infer<typeof DriverEnum>;

/**
 * Shape every `connectors.slug` must satisfy, mirroring the DB CHECK
 * `connectors_slug_shape_check` exactly.
 *
 * The `__`-run ban is load-bearing rather than cosmetic: a remote MCP tool
 * is exposed to the model as `mcp_<slug>__<tool>`, so `__` is the split
 * point between the two halves of that name. A slug allowed to contain it
 * would make the split ambiguous and route a call to the wrong server.
 * Applies to every driver because one namespace of slugs is what makes the
 * split point unambiguous — a per-driver rule would only hold until an
 * `http` connector borrowed a slug an `mcp` one wanted.
 */
export const CONNECTOR_SLUG_RE = /^[a-zA-Z0-9]([a-zA-Z0-9_-]{0,62}[a-zA-Z0-9])?$/;

export const ConnectorSlugSchema = z
  .string()
  .regex(CONNECTOR_SLUG_RE, "slug must be alphanumeric with - or _ inside, 1-64 chars")
  .refine((s) => !s.includes("__"), {
    message: "slug must not contain a double underscore — it separates `mcp_<slug>__<tool>`",
  });

export const EnvironmentEnum = z.enum(["dev", "prod"]);
export type Environment = z.infer<typeof EnvironmentEnum>;
export const ConnectorTemplateSourceEnum = z.enum(["builtin", "tenant"]);
export type ConnectorTemplateSource = z.infer<typeof ConnectorTemplateSourceEnum>;

// A strict subset of the DB `credential_mode` enum (db/schema/connectors.ts):
// the modes a connector may DECLARE as its auth. `oauth2_client` and
// `oauth2_private_key` are here because the two machine-to-machine MCP auth
// flows the driver serves — client credentials and private-key JWT — store
// their secret under exactly those credential modes, and a connector that
// cannot declare its own auth could not be created through the API at all.
// `token_mint` stays out: it is a credential mode, never a declared one.
export const AuthTypeEnum = z
  .enum([
    "none",
    "header",
    "query",
    "bearer",
    "basic",
    "oauth2",
    "oauth2_client",
    "oauth2_private_key",
    "aws_sigv4",
  ])
  // One enum serves every driver, so without this sentence the generated
  // contract would advertise the two machine-to-machine MCP kinds to `http`
  // callers as well. `MCP_ONLY_AUTH_TYPES` in connectors/config-schemas.ts is
  // what enforces it; this only says so where an API consumer reads.
  .openapi({
    description:
      "How the credential layer applies this connector's secret. `oauth2_client` and `oauth2_private_key` are accepted only for driver `mcp` — declaring either on any other driver is a 400.",
  });
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
    // Shape-checked here because `createConnector` uses a caller-supplied slug
    // RAW (only a generated one goes through `slugify`), so this is the only
    // application-layer gate in front of the DB CHECK.
    slug: ConnectorSlugSchema.optional(),
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
  // An mcp connector with no `base_url` has nothing to hand the transport, and
  // the failure would otherwise surface at handshake time as a URL parse error
  // naming neither the field nor the connector. No other driver is refined
  // here: http tolerates a per-step absolute url, s3 addresses its bucket
  // through config, and postgres connects through `dsn`.
  .superRefine((v, ctx) => {
    if (v.driver === "mcp" && !v.base_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["base_url"],
        message: "mcp connectors require base_url — the remote server's streamable-HTTP endpoint",
      });
    }
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

/** A single fetchable self-description link a connector publishes. LINKS ONLY —
 *  never the document body. The full content lives in the discovery cache or is
 *  fetched on demand at authoring time. */
export interface ConnectorSelfDescriptionLink {
  kind: "llms_txt" | "llms_full" | "openapi" | "graphql";
  url: string;
  source: "discovery" | "self_healing" | "manual";
  /** ISO-8601 timestamp the link was discovered/last refreshed. */
  discovered_at: string;
}

/** Lightweight metadata recording where a connector publishes its own machine
 *  docs. Surfaced to authoring + API/MCP consumers so they can fetch on demand. */
export interface ConnectorSelfDescription {
  links?: ConnectorSelfDescriptionLink[];
}

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
  /** Fetchable self-description links (llms.txt / llms-full / OpenAPI / GraphQL)
   *  the connector publishes — links only, never the document bodies. */
  self_description: ConnectorSelfDescription;
  created_at: Date;
  updated_at: Date;
  /** Operator on/off switch. The one connector bit only a human sets —
   *  distinct from the engine-derived `health_state` and `circuit_state`. */
  enabled: boolean;
  /** The engine's own account of the most recent failed interaction,
   *  formatted `[<error_code>] <sentence>` — never text the remote wrote.
   *  Written today only by the MCP handshake path; null on the other
   *  drivers, where `health_reason` carries the verdict. */
  last_error: string | null;
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
