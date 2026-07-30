// Session state for a connector whose driver is `mcp`. 1:1 with
// `connectors` — `connector_id` is the primary key, so the relationship
// is structural rather than conventional.
//
// Why a separate table rather than more columns on `connectors`:
//
//   * These columns describe a negotiated, stateful session. Every other
//     driver is stateless per request and would carry them as NULL.
//   * `tools_manifest_hash` has a sole-writer contract (below) that the
//     connector PATCH surface would break by construction. Keeping it off
//     `connectors` keeps the contract structural instead of a convention
//     each new writer has to be told about.
//
// Error text does NOT live here. `connectors.last_error` is the generic,
// driver-agnostic slot for the most recent upstream failure, and a second
// error column for the same row-pair would be free to disagree with it.
//
// A row exists only once a session has actually been negotiated. A
// registered-but-never-connected server has no row here — an all-NULL row
// would assert a session that never happened.

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
    // MCP protocol version agreed during `initialize`, verbatim as the
    // remote reported it. NULL when the session never reported one — the
    // version we PROPOSED is a different claim and is never written here.
    negotiated_protocol_version: text("negotiated_protocol_version"),
    // Capabilities the remote declared during `initialize`, verbatim.
    // Opaque jsonb: the spec grows capability keys faster than a typed
    // column set can follow, and a reader that needs one asks for it.
    server_capabilities: jsonb("server_capabilities").$type<Record<string, unknown>>(),
    // Hash of the most recently observed tool manifest. Drives tool-cache
    // invalidation when the remote changes its tools.
    // SOLE WRITERS: the handshake path and the schema-drift reconciler.
    // No operator-facing update surface may write it — the SIEM
    // discriminator for manifest drift is "this column changed and
    // nothing else did", which only holds while no human edit can touch
    // it.
    tools_manifest_hash: text("tools_manifest_hash"),
    last_handshake_at: timestamp("last_handshake_at", { withTimezone: true }),
    // Handshake backoff. Writers increment `consecutive_failures` and set
    // `backoff_until` when a handshake fails, and MUST clear both on the
    // next successful handshake — a stale non-zero counter would keep
    // widening the backoff window of a server that is already healthy.
    consecutive_failures: integer("consecutive_failures").notNull().default(0),
    backoff_until: timestamp("backoff_until", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("connector_mcp_sessions_tenant_idx").on(t.tenant_id)],
);
