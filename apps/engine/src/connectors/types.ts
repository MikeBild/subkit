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

export const AuthTypeEnum = z.enum(["none", "header", "query", "bearer", "basic", "oauth2"]);
export type AuthType = z.infer<typeof AuthTypeEnum>;

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
    client_id: z.string(),
    client_secret: z.string().optional(),
    grant_type: z.enum(["authorization_code", "client_credentials", "device_code"]),
    scope: z.string().optional(),
    redirect_uri: z.string().optional(),
    audience: z.string().optional(),
  })
  .openapi("OAuth2AuthConfig");

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
  ])
  .openapi("AuthConfig");

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

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
  created_at: Date;
  updated_at: Date;
}
