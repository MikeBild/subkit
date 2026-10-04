import { sql } from "drizzle-orm";
import {
  check,
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
    name: text("name").notNull(),
    base_url: text("base_url").notNull(),
    issuer: text("issuer").notNull(),
    authorization_endpoint: text("authorization_endpoint").notNull(),
    token_endpoint: text("token_endpoint").notNull(),
    registration_endpoint: text("registration_endpoint"),
    client_id: text("client_id").notNull(),
    authority_revision: integer("authority_revision").notNull().default(1),
    scopes: jsonb("scopes").notNull().$type<string[]>(),
    granted_scopes: jsonb("granted_scopes").$type<string[] | null>(),
    service_name: text("service_name"),
    service_description: text("service_description"),
    access_token_version: integer("access_token_version").notNull(),
    refresh_token_version: integer("refresh_token_version"),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    last_used_at: timestamp("last_used_at", { withTimezone: true }),
    last_refreshed_at: timestamp("last_refreshed_at", { withTimezone: true }),
    refresh_failed_at: timestamp("refresh_failed_at", { withTimezone: true }),
    last_error: text("last_error"),
    created_by: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("outbound_connections_tenant_name_key").on(t.tenant_id, t.name),
    check("outbound_connections_authority_revision_positive", sql`${t.authority_revision} > 0`),
    index("outbound_connections_expires_idx").on(t.expires_at),
  ],
);

export const outboundConnectionStarts = pgTable(
  "outbound_connection_starts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").notNull(),
    state_sha256: text("state_sha256").notNull(),
    code_verifier: text("code_verifier").notNull(),
    redirect_uri: text("redirect_uri").notNull(),
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
