import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";
import { tasks } from "./tasks.ts";
import { workflows } from "./workflows.ts";

export const SCHEDULE_OCCURRENCE_STATES = ["ran", "ran_late", "skipped", "held"] as const;
export type ScheduleOccurrenceState = (typeof SCHEDULE_OCCURRENCE_STATES)[number];

export const scheduleOccurrences = pgTable(
  "schedule_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workflow_id: uuid("workflow_id").references(() => workflows.id, { onDelete: "cascade" }),
    task_id: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    schedule_id: uuid("schedule_id"),
    due_at: timestamp("due_at", { withTimezone: true }).notNull(),
    last_due_at: timestamp("last_due_at", { withTimezone: true }).notNull(),
    started_at: timestamp("started_at", { withTimezone: true }),
    state: text("state").$type<ScheduleOccurrenceState>().notNull(),
    reason_code: text("reason_code"),
    skipped_count: integer("skipped_count").notNull().default(0),
    execution_id: uuid("execution_id"),
    task_run_id: uuid("task_run_id"),
    ...timestamps,
  },
  (t) => [
    index("schedule_occurrences_workflow_idx")
      .on(t.tenant_id, t.workflow_id, t.due_at.desc())
      .where(sql`${t.workflow_id} IS NOT NULL`),
    index("schedule_occurrences_task_idx")
      .on(t.tenant_id, t.task_id, t.due_at.desc())
      .where(sql`${t.task_id} IS NOT NULL`),
    index("schedule_occurrences_retention_idx").on(t.created_at),
    check(
      "schedule_occurrences_subject_check",
      sql`(${t.workflow_id} IS NULL) <> (${t.task_id} IS NULL)`,
    ),
    check(
      "schedule_occurrences_state_check",
      sql`${t.state} IN ('ran', 'ran_late', 'skipped', 'held')`,
    ),
    check(
      "schedule_occurrences_reason_check",
      sql`${t.reason_code} IS NULL OR ${t.reason_code} ~ '^[a-z][a-z0-9_]{0,99}$'`,
    ),
    check(
      "schedule_occurrences_window_check",
      sql`${t.last_due_at} >= ${t.due_at} AND ${t.skipped_count} BETWEEN 0 AND 100000`,
    ),
    check(
      "schedule_occurrences_run_check",
      sql`(${t.state} IN ('ran', 'ran_late')) = (${t.started_at} IS NOT NULL)`,
    ),
  ],
);

export type ScheduleOccurrenceRow = typeof scheduleOccurrences.$inferSelect;
