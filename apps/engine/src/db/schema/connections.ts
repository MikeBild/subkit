// Outbound connections — SubKit as an OAuth 2.1 CLIENT of another system.
//
// A person types a base URL in the Cockpit, picks scopes, approves on the
// other side, and SubKit holds the grant from then on. The tokens themselves
// are NOT in these tables: they are versions in `runtime_secret_versions`
// (`secret://connection.<name>.access_token/<n>`), encrypted like every
// other runtime secret and rewrapped by `--rewrap-master-key` with them.
// These rows hold what is needed to USE and RENEW the grant — the discovered
// endpoints, the registered client id, the scopes, and where the current
// versions live.

import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants, users } from "./identity.ts";

export const outboundConnections = pgTable(
  "outbound_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    /** The binding name the person chose. Also the secret-name stem. */
    name: text("name").notNull(),
    /** What the person typed, normalised (no trailing slash). */
    base_url: text("base_url").notNull(),
    /** The `issuer` the server advertised in its discovery document. */
    issuer: text("issuer").notNull(),
    authorization_endpoint: text("authorization_endpoint").notNull(),
    token_endpoint: text("token_endpoint").notNull(),
    registration_endpoint: text("registration_endpoint"),
    /** The client id the server handed out at dynamic registration. Public client, no secret. */
    client_id: text("client_id").notNull(),
    /** Scopes the person asked for, in the order picked. */
    scopes: jsonb("scopes").notNull().$type<string[]>(),
    /** Scopes the server actually granted (may be a subset), null when it did not say. */
    granted_scopes: jsonb("granted_scopes").$type<string[] | null>(),
    /** `name`/`description` from `/.well-known/service-descriptor.json`, when present. */
    service_name: text("service_name"),
    service_description: text("service_description"),
    /** Current versions of the two secrets. Refresh mints new ones and revokes the old. */
    access_token_version: integer("access_token_version").notNull(),
    refresh_token_version: integer("refresh_token_version"),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    last_used_at: timestamp("last_used_at", { withTimezone: true }),
    last_refreshed_at: timestamp("last_refreshed_at", { withTimezone: true }),
    /** Set when the last automatic refresh failed; cleared by a successful one or by "Erneuern". */
    refresh_failed_at: timestamp("refresh_failed_at", { withTimezone: true }),
    last_error: text("last_error"),
    created_by: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("outbound_connections_tenant_name_key").on(t.tenant_id, t.name),
    index("outbound_connections_expires_idx").on(t.expires_at),
  ],
);

/**
 * An authorization round in flight: state + PKCE verifier + everything the
 * callback needs to finish without trusting the query string. Ten-minute TTL;
 * consumed exactly once.
 */
export const outboundConnectionStarts = pgTable(
  "outbound_connection_starts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").notNull(),
    /** sha256 of the opaque `state` the browser carries. */
    state_sha256: text("state_sha256").notNull(),
    code_verifier: text("code_verifier").notNull(),
    redirect_uri: text("redirect_uri").notNull(),
    /** Renewal of an existing connection, or null for a new one. */
    connection_id: uuid("connection_id").references(() => outboundConnections.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    base_url: text("base_url").notNull(),
    issuer: text("issuer").notNull(),
    authorization_endpoint: text("authorization_endpoint").notNull(),
    token_endpoint: text("token_endpoint").notNull(),
    registration_endpoint: text("registration_endpoint"),
    client_id: text("client_id").notNull(),
    scopes: jsonb("scopes").notNull().$type<string[]>(),
    service_name: text("service_name"),
    service_description: text("service_description"),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("outbound_connection_starts_state_key").on(t.state_sha256)],
);
