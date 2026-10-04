import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { connectors } from "./connectors.ts";
import { tenants } from "./identity.ts";

export const connectorMcpSessions = pgTable(
  "connector_mcp_sessions",
  {
    connector_id: uuid("connector_id")
      .primaryKey()
      .references(() => connectors.id, { onDelete: "cascade" }),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    negotiated_protocol_version: text("negotiated_protocol_version"),
    server_capabilities: jsonb("server_capabilities").$type<Record<string, unknown>>(),
    tools_manifest_hash: text("tools_manifest_hash"),
    last_handshake_at: timestamp("last_handshake_at", { withTimezone: true }),
    consecutive_failures: integer("consecutive_failures").notNull().default(0),
    backoff_until: timestamp("backoff_until", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("connector_mcp_sessions_tenant_idx").on(t.tenant_id)],
);
