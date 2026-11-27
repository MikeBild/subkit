import { z } from "@hono/zod-openapi";
import {
  AcceptDescriptionSchema,
  type CatalogSource,
  CategorySchema,
  DescriptionSchema,
  descriptionAcceptanceValid,
} from "../api/catalog-metadata.ts";
import { SignedJwtConfigSchema } from "../credentials/signed-jwt.ts";

export const LOCAL_DRIVERS = ["local_files", "local_browser", "local_computer"] as const;
export const DriverEnum = z.enum([
  "http",
  "postgres",
  "s3",
  "sftp",
  "graphql",
  "mcp",
  ...LOCAL_DRIVERS,
]);
export type DriverName = z.infer<typeof DriverEnum>;

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
    "signed_jwt",
    "aws_sigv4",
  ])
  .openapi({
    description:
      "How the credential layer applies this connector's secret. `oauth2_client` and `oauth2_private_key` are accepted only for driver `mcp`; `signed_jwt` is accepted only for HTTP and GraphQL connectors.",
  });
export type AuthType = z.infer<typeof AuthTypeEnum>;

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
    token_request_body_mapping: z.record(z.string(), z.string()).optional(),
    token_response_format: z.enum(["raw", "json"]).optional(),
    token_response_ttl_ms: z.number().positive().optional(),
    refresh_buffer_ms: z.number().positive().optional(),
  })
  .strict();

export const LocalTlsConfigSchema = z
  .object({
    ca_pem: z
      .string()
      .max(65_536)
      .regex(/-----BEGIN CERTIFICATE-----/, "ca_pem must be a PEM certificate")
      .optional(),
    skip_verify: z.boolean().optional(),
  })
  .strict();

export const HttpConnectorConfig = z
  .object({
    tls: LocalTlsConfigSchema.optional(),
    static_headers: z.record(z.string(), z.string()).optional(),
    static_query: z.record(z.string(), z.string()).optional(),
    timeout_ms: z.number().positive().max(300_000).optional(),
    max_retries: z.number().int().min(0).max(5).optional(),
    follow_redirects: z.boolean().default(true).optional(),
    aws_region: z.string().optional(),
    aws_service: z.string().optional(),
    probe_endpoint: z.record(z.string(), z.unknown()).nullable().optional(),
    pagination_defaults: z.record(z.string(), z.unknown()).nullable().optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    credential_hints: z.array(z.record(z.string(), z.unknown())).optional(),
    imported_sample_endpoints: z.array(z.record(z.string(), z.unknown())).optional(),
    imported_source: z.string().optional(),
    oauth: OAuthEnrichmentSchema.optional(),
    signed_jwt: SignedJwtConfigSchema.optional(),
  })
  .strict();

function mcpTransportOf(config: Record<string, unknown> | undefined): unknown {
  const block = config?.mcp;
  return block && typeof block === "object" && !Array.isArray(block)
    ? (block as Record<string, unknown>).transport
    : undefined;
}

export const CreateConnectorSchema = z
  .object({
    name: z.string().min(1),
    slug: ConnectorSlugSchema.optional(),
    driver: DriverEnum,
    environment: EnvironmentEnum.default("dev"),
    base_url: z.string().url().optional(),
    dsn: z.string().optional(),
    auth_type: AuthTypeEnum.default("none"),
    config: z.record(z.string(), z.unknown()).optional(),
    operator_quirks: OperatorQuirksSchema.optional(),
    template_slug: z.string().min(1).optional(),
    template_source: ConnectorTemplateSourceEnum.optional(),
    template_base_url_environment: z.string().min(1).optional(),
    description: DescriptionSchema.nullable().optional(),
    category: CategorySchema.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    const stdio = v.driver === "mcp" && mcpTransportOf(v.config) === "stdio";
    if (stdio && v.base_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["base_url"],
        message:
          "a stdio MCP server has no address — leave base_url empty and set config.mcp.command",
      });
    }
    if (v.driver === "mcp" && !stdio && !v.base_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["base_url"],
        message:
          'mcp connectors require base_url — the server\'s streamable-HTTP or SSE endpoint; for a local command set config.mcp.transport to "stdio"',
      });
    }
    if (v.auth_type === "signed_jwt") {
      const parsed = SignedJwtConfigSchema.safeParse(v.config?.signed_jwt);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["config", "signed_jwt", ...issue.path],
            message: issue.message,
          });
        }
      }
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
    operator_quirks: OperatorQuirksSchema.optional(),
    template_slug: z.string().min(1).optional(),
    template_source: ConnectorTemplateSourceEnum.optional(),
    template_base_url_environment: z.string().min(1).optional(),
    clear_template_binding: z.boolean().optional(),
    description: DescriptionSchema.nullable().optional(),
    accept_description: AcceptDescriptionSchema.optional(),
    category: CategorySchema.nullable().optional(),
  })
  .refine(descriptionAcceptanceValid, {
    message: "accept_description requires the exact nonempty description",
    path: ["accept_description"],
  })
  .openapi("UpdateConnectorBody");

export type UpdateConnectorInput = z.infer<typeof UpdateConnectorSchema>;

export interface ConnectorSelfDescriptionLink {
  kind: "llms_txt" | "llms_full" | "openapi" | "graphql";
  url: string;
  source: "discovery" | "self_healing" | "manual";
  discovered_at: string;
}

export interface ConnectorSelfDescription {
  links?: ConnectorSelfDescriptionLink[];
}

export interface ConnectorView {
  id: string;
  tenant_id: string;
  slug: string;
  display_name: string;
  description: string | null;
  description_source: CatalogSource;
  category: string;
  category_source: CatalogSource;
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
  self_description: ConnectorSelfDescription;
  created_at: Date;
  updated_at: Date;
  enabled: boolean;
  last_error: string | null;
  circuit_state: "closed" | "open" | "half-open";
  circuit_opened_at: Date | null;
  circuit_failure_count: number;
  circuit_threshold: number;
  circuit_reset_ms: number;
  needs_reauth: boolean;
  auth_failed_at: Date | null;
  auth_failed_reason: string | null;
  health_state: string;
  health_reason: string | null;
  health_error_code: string | null;
  sunset_at: Date | null;
  successor_uri: string | null;
}
