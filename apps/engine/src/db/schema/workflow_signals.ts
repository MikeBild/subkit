// Inbound runtime signals for wait-for-event steps. HITL approval
// and other signal-driven workflows POST to /v1/runs/{id}/signals; the
// route writes a row here, and the step-runner's wait-for-event poller
// matches it against the active step's `event_name` + dot-notation
// predicate.
//
// GC TTL: rows live for `wait_for_event.timeout_ms + 24h grace` (the
// retention sweep deletes anything older). The `received_at` index
// powers the sweep; `(tenant_id, execution_id, event_name)` powers the
// match query.
//
// PK: UUID surrogate. Tenant-scoped; FK cascades on tenant + execution
// deletion so a removed run cannot leave dangling signals.

import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { executions } from "./executions.ts";
import { tenants } from "./identity.ts";

export const workflowSignals = pgTable(
  "workflow_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    execution_id: uuid("execution_id")
      .notNull()
      .references(() => executions.id, { onDelete: "cascade" }),
    event_name: text("event_name").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    received_at: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("workflow_signals_match_idx").on(t.tenant_id, t.execution_id, t.event_name),
    index("workflow_signals_received_at_idx").on(t.received_at),
  ],
);
