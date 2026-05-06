// In-flight wait checkpoints (#48 SHRUNK). One row per in-flight wait
// step. Written when the step starts; deleted when it completes (timer
// fired) or is cancelled (abort signal).
//
// Engine boot reads this table to recover orphaned waits — runs whose
// process died mid-`setTimeout`. The reaper compares `sleep_until_ts`
// against `now()`: rows in the past resume immediately, rows in the
// future re-enqueue an `execution.run` job with `sendAfter`. Restart
// safety without a separate pg-boss queue.
//
// The cap is 24h (`WaitStepSchema.duration_ms.max`) — multi-day patterns
// use the Schedule + State recipe (#51 + A8), not durable wait. PK is
// UUID; uniqueness on `(tenant_id, execution_id, step_id)`.

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
