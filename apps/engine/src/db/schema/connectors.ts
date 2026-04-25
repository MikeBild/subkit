import {
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
import { bytea, tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const environmentEnum = pgEnum("environment", ["dev", "prod"]);
export const credentialModeEnum = pgEnum("credential_mode", [
  "none",
  "header",
  "query",
  "bearer",
  "basic",
  "oauth2",
]);
export const endUserCombineModeEnum = pgEnum("end_user_combine_mode", ["merge", "replace"]);
export const connectorTemplateSourceEnum = pgEnum("connector_template_source", [
  "builtin",
  "tenant",
]);

// ----- connectors -----------------------------------------------------------

export const connectors = pgTable(
  "connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    display_name: text("display_name").notNull(),
    driver: text("driver").notNull(),
    environment: environmentEnum("environment").notNull().default("dev"),
    auth_type: credentialModeEnum("auth_type").notNull().default("none"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    base_url: text("base_url"),
    dsn: text("dsn"),
    template_slug: text("template_slug"),
    template_name: text("template_name"),
    template_source: connectorTemplateSourceEnum("template_source"),
    template_version: integer("template_version"),
    template_snapshot: jsonb("template_snapshot").$type<Record<string, unknown>>(),
    tunnel_id: uuid("tunnel_id"),
    auto_refresh_cron: text("auto_refresh_cron"),
    last_ingested_at: timestamp("last_ingested_at", { withTimezone: true }),
    circuit_state: text("circuit_state").notNull().default("closed"),
    circuit_opened_at: timestamp("circuit_opened_at", { withTimezone: true }),
    circuit_failure_count: integer("circuit_failure_count").notNull().default(0),
    circuit_threshold: integer("circuit_threshold").notNull().default(5),
    circuit_reset_ms: integer("circuit_reset_ms").notNull().default(300000),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("connectors_tenant_slug_env_key").on(t.tenant_id, t.slug, t.environment)],
);

// ----- connector_oauth_states ----------------------------------------------

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
  },
  (t) => [uniqueIndex("connector_oauth_states_state_key").on(t.state)],
);

// ----- connector_environments ----------------------------------------------

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

// ----- credentials ----------------------------------------------------------

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
    // AES-256-GCM ciphertext (see apps/engine/src/crypto/aes-gcm.ts). Writers call encryptSecret(), readers decryptSecret(), keyed by env.MASTER_KEY.
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    auth_tag: bytea("auth_tag").notNull(),
    oauth2_refresh_ciphertext: bytea("oauth2_refresh_ciphertext"),
    oauth2_refresh_iv: bytea("oauth2_refresh_iv"),
    oauth2_refresh_auth_tag: bytea("oauth2_refresh_auth_tag"),
    oauth2_expires_at: timestamp("oauth2_expires_at", { withTimezone: true }),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("credentials_connector_env_key").on(t.connector_id, t.environment)],
);

// ----- end_user_credentials -------------------------------------------------

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
    // AES-256-GCM ciphertext (see apps/engine/src/crypto/aes-gcm.ts). Writers call encryptSecret(), readers decryptSecret(), keyed by env.MASTER_KEY.
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    auth_tag: bytea("auth_tag").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("end_user_credentials_unique_key").on(t.tenant_id, t.connector_id, t.enduser_ref),
  ],
);

// ----- schema_versions ------------------------------------------------------

export const schemaVersions = pgTable(
  "schema_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    endpoint_key: text("endpoint_key").notNull(),
    schema: jsonb("schema").notNull(),
    seen_at: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("schema_versions_connector_endpoint_seen_idx").on(
      t.connector_id,
      t.endpoint_key,
      t.seen_at,
    ),
  ],
);
