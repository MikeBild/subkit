import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { executions } from "./executions.ts";
import { tenants } from "./identity.ts";
import { workflows } from "./workflows.ts";

export const workflowWaits = pgTable(
  "workflow_waits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    execution_id: uuid("execution_id")
      .notNull()
      .references(() => executions.id, { onDelete: "cascade" }),
    workflow_id: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    step_id: text("step_id").notNull(),
    sleep_until_ts: timestamp("sleep_until_ts", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("workflow_waits_tenant_execution_step_uniq").on(
      t.tenant_id,
      t.execution_id,
      t.step_id,
    ),
    index("workflow_waits_sleep_until_idx").on(t.sleep_until_ts),
  ],
);
