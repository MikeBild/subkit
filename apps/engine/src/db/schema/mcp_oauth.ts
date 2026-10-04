import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const mcpOauthClients = pgTable(
  "mcp_oauth_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    client_id: text("client_id").notNull(),
    redirect_uris: jsonb("redirect_uris").notNull().default(sql`'[]'::jsonb`).$type<string[]>(),
    grant_types: jsonb("grant_types")
      .notNull()
      .default(sql`'["authorization_code", "refresh_token"]'::jsonb`)
      .$type<string[]>(),
    token_endpoint_auth_method: text("token_endpoint_auth_method")
      .notNull()
      .default("none")
      .$type<"none">(),
    scope: text("scope").notNull().default("mcp:read"),
    client_name: text("client_name"),
    client_uri: text("client_uri"),
    software_id: text("software_id"),
    registration_source: text("registration_source")
      .notNull()
      .default("dcr")
      .$type<"dcr" | "manual">(),
    disabled_at: timestamp("disabled_at", { withTimezone: true }),
    retired_at: timestamp("retired_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("mcp_oauth_clients_client_id_key").on(t.client_id),
    check(
      "mcp_oauth_clients_token_endpoint_auth_method_check",
      sql`${t.token_endpoint_auth_method} = 'none'`,
    ),
    check(
      "mcp_oauth_clients_registration_source_check",
      sql`${t.registration_source} IN ('dcr','manual')`,
    ),
  ],
);

export const mcpOauthAuthorizationCodes = pgTable(
  "mcp_oauth_authorization_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    client_id: text("client_id").notNull(),
    user_id: uuid("user_id").notNull(),
    code_sha256: text("code_sha256").notNull(),
    code_challenge: text("code_challenge").notNull(),
    code_challenge_method: text("code_challenge_method").notNull().$type<"S256">(),
    redirect_uri: text("redirect_uri").notNull(),
    scope: text("scope").notNull(),
    resource: text("resource"),
    state: text("state"),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("mcp_oauth_authorization_codes_sha256_key").on(t.code_sha256),
    index("mcp_oauth_authorization_codes_expires_idx").on(t.expires_at),
    check(
      "mcp_oauth_authorization_codes_code_challenge_method_check",
      sql`${t.code_challenge_method} = 'S256'`,
    ),
  ],
);

export const mcpOauthRefreshTokens = pgTable(
  "mcp_oauth_refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    client_id: text("client_id").notNull(),
    user_id: uuid("user_id").notNull(),
    prefix: text("prefix").notNull(),
    token_sha256: text("token_sha256").notNull(),
    scope: text("scope").notNull(),
    resource: text("resource"),
    rotated_to_id: uuid("rotated_to_id").references((): AnyPgColumn => mcpOauthRefreshTokens.id),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("mcp_oauth_refresh_tokens_sha256_key").on(t.token_sha256),
    index("mcp_oauth_refresh_tokens_prefix_idx").on(t.prefix),
    index("mcp_oauth_refresh_tokens_tenant_idx").on(t.tenant_id),
  ],
);

export const mcpOauthAccessTokens = pgTable(
  "mcp_oauth_access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    client_id: text("client_id").notNull(),
    user_id: uuid("user_id").notNull(),
    prefix: text("prefix").notNull(),
    token_sha256: text("token_sha256").notNull(),
    scope: text("scope").notNull(),
    resource: text("resource"),
    refresh_token_id: uuid("refresh_token_id").references(() => mcpOauthRefreshTokens.id, {
      onDelete: "set null",
    }),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    last_used_at: timestamp("last_used_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("mcp_oauth_access_tokens_sha256_key").on(t.token_sha256),
    index("mcp_oauth_access_tokens_prefix_idx").on(t.prefix),
    index("mcp_oauth_access_tokens_tenant_idx").on(t.tenant_id),
  ],
);
