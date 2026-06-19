// Persisted scan history for proactive self-healing drift sweeps.
//
// One row per `scanForDrift()` invocation — whether triggered by the
// scheduler reconciler, an admin POST /v1/self-healing/scans request,
// or the MCP `self_healing.scan` tool. The row is created in
// status='running' before the scan starts, updated with counters +
// duration_ms + status='succeeded' on completion, or status='failed' +
// error on a thrown exception inside the scan path.
//
// `idempotency_key` carries the Idempotency-Key header value when the
// caller supplies one. Combined with a unique index on
// (tenant_id, idempotency_key), this lets the route layer detect a
// safe-to-replay double-submit and return the prior result instead of
// running the scan twice. The unique index is partial (WHERE key IS
// NOT NULL) so anonymous scans don't collide on the missing key.

import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const selfHealingScans = pgTable(
  "self_healing_scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    // "scheduler" | "admin_http" | "mcp" — kept as plain text so adding a
    // new entry point later does not need a migration.
    source: text("source").notNull(),
    // { tenant_id?, workflow_id?, connector_id? } — the targeting filters
    // the caller passed in. The scheduler always stamps a single
    // { tenant_id } object.
    filters: jsonb("filters").notNull(),
    // Operator who triggered the scan; NULL for the scheduler.
    actor_id: uuid("actor_id"),
    // Optional Idempotency-Key header value. Replayed POSTs within the
    // 24h window return the original scan row.
    idempotency_key: text("idempotency_key"),
    signals_detected: integer("signals_detected").notNull().default(0),
    candidates_created: integer("candidates_created").notNull().default(0),
    // Drift signals the scanner found but could not promote to a
    // Patch Candidate because no workflow anchor exists (hook surfaces,
    // orphan connectors). Operators read this off the scan row when
    // reviewing past scans via GET /v1/self-healing/scans/{id} — the
    // live POST response carries the per-entry list; the row carries
    // only the count.
    unanchored_detected: integer("unanchored_detected").notNull().default(0),
    duration_ms: integer("duration_ms"),
    // "running" | "succeeded" | "failed"
    status: text("status").notNull(),
    // Populated only when status='failed'.
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    index("self_healing_scans_tenant_created_idx").on(t.tenant_id, t.created_at),
    uniqueIndex("self_healing_scans_idem_key").on(t.tenant_id, t.idempotency_key),
  ],
);
