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
