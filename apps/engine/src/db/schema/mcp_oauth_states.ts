import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantId } from "./_common.ts";
import { connectors } from "./connectors.ts";
import { tenants } from "./identity.ts";

export const mcpOauthStates = pgTable(
  "mcp_oauth_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    code_verifier: text("code_verifier").notNull().default(""),
    redirect_uri: text("redirect_uri").notNull(),
    authorization_url: text("authorization_url"),
    as_issuer: text("as_issuer"),
    requested_scopes: text("requested_scopes"),
    started_by_actor_id: uuid("started_by_actor_id"),
    started_by_actor_type: text("started_by_actor_type").$type<"user" | "system_account">(),
    origin: text("origin"),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("mcp_oauth_states_state_key").on(t.state),
    index("mcp_oauth_states_tenant_server_idx").on(t.tenant_id, t.connector_id),
  ],
);

export type McpOauthStateRow = typeof mcpOauthStates.$inferSelect;
