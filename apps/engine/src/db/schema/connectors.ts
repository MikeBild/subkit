import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  bytea,
  catalogMetadata,
  catalogMetadataConstraints,
  tenantId,
  timestamps,
} from "./_common.ts";
import { outboundConnections } from "./connections.ts";
import { tenants } from "./identity.ts";

export const environmentEnum = pgEnum("environment", ["dev", "prod"]);
export const credentialModeEnum = pgEnum("credential_mode", [
  "none",
  "header",
  "query",
  "bearer",
  "basic",
  "oauth2",
  "aws_sigv4",
  "token_mint",
  "oauth2_client",
  "oauth2_private_key",
]);
export const endUserCombineModeEnum = pgEnum("end_user_combine_mode", ["merge", "replace"]);
export const connectorTemplateSourceEnum = pgEnum("connector_template_source", [
  "builtin",
  "tenant",
]);

export const connectors = pgTable(
  "connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    display_name: text("display_name").notNull(),
    ...catalogMetadata(),
    driver: text("driver").notNull(),
    environment: environmentEnum("environment").notNull().default("dev"),
    auth_type: credentialModeEnum("auth_type").notNull().default("none"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    base_url: text("base_url"),
    dsn: text("dsn"),
    operator_quirks: jsonb("operator_quirks")
      .$type<Partial<Record<string, string>>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    self_description: jsonb("self_description")
      .$type<{
        links?: Array<{
          kind: "llms_txt" | "llms_full" | "openapi" | "graphql";
          url: string;
          source: "discovery" | "self_healing" | "manual";
          discovered_at: string;
        }>;
      }>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    template_slug: text("template_slug"),
    template_name: text("template_name"),
    template_source: connectorTemplateSourceEnum("template_source"),
    template_version: integer("template_version"),
    template_snapshot: jsonb("template_snapshot").$type<Record<string, unknown>>(),
    auto_refresh_cron: text("auto_refresh_cron"),
    last_ingested_at: timestamp("last_ingested_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    last_error: text("last_error"),
    circuit_state: text("circuit_state").notNull().default("closed"),
    circuit_opened_at: timestamp("circuit_opened_at", { withTimezone: true }),
    circuit_failure_count: integer("circuit_failure_count").notNull().default(0),
    circuit_threshold: integer("circuit_threshold").notNull().default(5),
    circuit_reset_ms: integer("circuit_reset_ms").notNull().default(300000),
    needs_reauth: boolean("needs_reauth").notNull().default(false),
    auth_failed_at: timestamp("auth_failed_at", { withTimezone: true }),
    auth_failed_reason: text("auth_failed_reason"),
    health_state: text("health_state").notNull().default("ok"),
    health_reason: text("health_reason"),
    health_error_code: text("health_error_code"),
    health_changed_at: timestamp("health_changed_at", { withTimezone: true }),
    sunset_at: timestamp("sunset_at", { withTimezone: true }),
    successor_uri: text("successor_uri"),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("connectors_tenant_slug_env_key")
      .on(t.tenant_id, t.slug, t.environment)
      .where(sql`${t.deleted_at} IS NULL`),
    index("connectors_needs_reauth_idx").on(t.tenant_id).where(sql`${t.needs_reauth} = true`),
    check(
      "connectors_slug_shape_check",
      sql`${t.slug} ~ '^[a-zA-Z0-9]([a-zA-Z0-9_-]{0,62}[a-zA-Z0-9])?$' AND ${t.slug} !~ '__'`,
    ),
    check(
      "connectors_mcp_auth_no_inline_secrets_check",
      sql`${t.config} -> 'mcp' -> 'auth' IS NULL OR NOT (
        ${t.config} -> 'mcp' -> 'auth' ? 'client_secret' OR
        ${t.config} -> 'mcp' -> 'auth' ? 'password' OR
        ${t.config} -> 'mcp' -> 'auth' ? 'passphrase' OR
        ${t.config} -> 'mcp' -> 'auth' ? 'api_key' OR
        ${t.config} -> 'mcp' -> 'auth' ? 'apikey' OR
        ${t.config} -> 'mcp' -> 'auth' ? 'access_token' OR
        ${t.config} -> 'mcp' -> 'auth' ? 'refresh_token' OR
        ${t.config} -> 'mcp' -> 'auth' ? 'bearer_token' OR
        ${t.config} -> 'mcp' -> 'auth' ? 'secret'
      )`,
    ),
    ...catalogMetadataConstraints("connectors", t),
  ],
);

export const connectorOauthStates = pgTable(
  "connector_oauth_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    code_verifier: text("code_verifier").notNull(),
    redirect_uri: text("redirect_uri").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    requested_scopes: text("requested_scopes"),
    origin: text("origin"),
  },
  (t) => [uniqueIndex("connector_oauth_states_state_key").on(t.state)],
);

export const connectorOauthStartGrants = pgTable(
  "connector_oauth_start_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    token_sha256: text("token_sha256").notNull(),
    created_by_actor_id: uuid("created_by_actor_id"),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("connector_oauth_start_grants_token_sha256_key").on(t.token_sha256)],
);

export const connectorCredentialSetupGrants = pgTable(
  "connector_credential_setup_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    token_sha256: text("token_sha256").notNull(),
    created_by_actor_id: uuid("created_by_actor_id"),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("connector_credential_setup_grants_token_sha256_key").on(t.token_sha256)],
);

export const connectorEnvironments = pgTable(
  "connector_environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    environment: environmentEnum("environment").notNull(),
    overrides: jsonb("overrides"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("connector_environments_connector_env_key").on(t.connector_id, t.environment),
  ],
);

export const connectorPromotions = pgTable(
  "connector_promotions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    idempotency_key_hash: text("idempotency_key_hash").notNull(),
    request_fingerprint: text("request_fingerprint").notNull(),
    source_connector_id: uuid("source_connector_id").notNull(),
    target_connector_id: uuid("target_connector_id").notNull(),
    strategy: text("strategy").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("connector_promotions_tenant_idempotency_key").on(
      t.tenant_id,
      t.idempotency_key_hash,
    ),
    index("connector_promotions_source_idx").on(t.tenant_id, t.source_connector_id),
    index("connector_promotions_target_idx").on(t.tenant_id, t.target_connector_id),
  ],
);

export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    environment: environmentEnum("environment").notNull(),
    mode: credentialModeEnum("mode").notNull(),
    authority_revision: integer("authority_revision").notNull().default(1),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    auth_tag: bytea("auth_tag").notNull(),
    oauth2_refresh_ciphertext: bytea("oauth2_refresh_ciphertext"),
    oauth2_refresh_iv: bytea("oauth2_refresh_iv"),
    oauth2_refresh_auth_tag: bytea("oauth2_refresh_auth_tag"),
    oauth2_expires_at: timestamp("oauth2_expires_at", { withTimezone: true }),
    granted_scopes: text("granted_scopes"),
    connection_id: uuid("connection_id").references(() => outboundConnections.id, {
      onDelete: "set null",
    }),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("credentials_connector_env_mode_key").on(t.connector_id, t.environment, t.mode),
    check("credentials_authority_revision_positive", sql`${t.authority_revision} > 0`),
  ],
);

export const endUserCredentials = pgTable(
  "end_user_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    enduser_ref: text("enduser_ref").notNull(),
    combine_mode: endUserCombineModeEnum("combine_mode").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    auth_tag: bytea("auth_tag").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("end_user_credentials_unique_key").on(t.tenant_id, t.connector_id, t.enduser_ref),
  ],
);

export const schemaVersions = pgTable(
  "schema_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    endpoint_key: text("endpoint_key").notNull(),
    workflow_id: uuid("workflow_id"),
    step_id: text("step_id"),
    schema: jsonb("schema").notNull(),
    observed_schema: jsonb("observed_schema"),
    seen_at: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("schema_versions_connector_endpoint_seen_idx").on(
      t.connector_id,
      t.endpoint_key,
      t.seen_at,
    ),
    index("schema_versions_provenance_seen_idx").on(
      t.tenant_id,
      t.connector_id,
      t.endpoint_key,
      t.workflow_id,
      t.step_id,
      t.seen_at,
    ),
  ],
);
