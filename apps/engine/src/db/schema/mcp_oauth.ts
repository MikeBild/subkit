// Drizzle schema for MCP OAuth 2.1 authorization server tables.
// Mirrors apps/engine/src/db/migrations/0024_mcp_oauth.sql exactly.

import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

// ── mcp_oauth_clients ─────────────────────────────────────────────────────────
// Public clients only (token_endpoint_auth_method = "none").
// tenant_id is not stored here — it binds on authorization codes/tokens.
export const mcpOauthClients = pgTable(
  "mcp_oauth_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    client_id: text("client_id").notNull(),
    redirect_uris: jsonb("redirect_uris").notNull().$type<string[]>(),
    grant_types: jsonb("grant_types").notNull().$type<string[]>(),
    token_endpoint_auth_method: text("token_endpoint_auth_method")
      .notNull()
      .default("none")
      .$type<"none">(),
    scope: text("scope").notNull().default("mcp:read"),
    client_name: text("client_name"),
    software_id: text("software_id"),
    registration_source: text("registration_source")
      .notNull()
      .default("dcr")
      .$type<"dcr" | "manual">(),
    disabled_at: timestamp("disabled_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("mcp_oauth_clients_client_id_key").on(t.client_id)],
);

// ── mcp_oauth_authorization_codes ─────────────────────────────────────────────
// Single-use PKCE S256 authorization codes. code_sha256 is the SHA-256 of the
// opaque plaintext code. consumed_at is set atomically on exchange.
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
  ],
);

// ── mcp_oauth_refresh_tokens ──────────────────────────────────────────────────
// Rotation chain: rotated_to_id points forward to the replacement token.
// Reusing a rotated token triggers chain revocation.
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
    rotated_to_id: uuid("rotated_to_id"),
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

// ── mcp_oauth_access_tokens ───────────────────────────────────────────────────
// Short-lived access tokens. prefix is a 12-char indexed lookup key.
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
    refresh_token_id: uuid("refresh_token_id"),
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
