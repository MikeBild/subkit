import { sql } from "drizzle-orm";
import { bigint, check, pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

export const schedulerSweepProducerEnum = pgEnum("scheduler_sweep_producer", [
  "catalog",
  "docs",
  "workflow-cron",
  "drift",
  "reauth",
  "endpoint-contract",
  "knowledge",
  "skill",
]);

export type SchedulerSweepProducer = (typeof schedulerSweepProducerEnum.enumValues)[number];

export const schedulerSweepCursors = pgTable(
  "scheduler_sweep_cursors",
  {
    producer: schedulerSweepProducerEnum("producer").primaryKey(),
    epoch: bigint("epoch", { mode: "number" }).default(0).notNull(),
    revision: bigint("revision", { mode: "number" }).default(0).notNull(),
    after_id: uuid("after_id"),
    epoch_upper_id: uuid("epoch_upper_id"),
    epoch_cutoff_at: timestamp("epoch_cutoff_at", { withTimezone: true, precision: 3 }),
    lease_owner_boot_id: uuid("lease_owner_boot_id"),
    lease_token: uuid("lease_token"),
    lease_until: timestamp("lease_until", { withTimezone: true, precision: 3 }),
    updated_at: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .default(sql`date_trunc('milliseconds', clock_timestamp())`)
      .notNull(),
  },
  (t) => [
    check("scheduler_sweep_epoch_safe", sql`${t.epoch} BETWEEN 0 AND 9007199254740991`),
    check("scheduler_sweep_revision_safe", sql`${t.revision} BETWEEN 0 AND 9007199254740991`),
    check(
      "scheduler_sweep_position_shape",
      sql`(${t.after_id} IS NULL AND ${t.epoch_upper_id} IS NULL AND ${t.epoch_cutoff_at} IS NULL AND ${t.lease_owner_boot_id} IS NULL AND ${t.lease_token} IS NULL AND ${t.lease_until} IS NULL) OR (${t.epoch} > 0 AND ${t.epoch_upper_id} IS NOT NULL AND ${t.epoch_cutoff_at} IS NOT NULL AND (${t.after_id} IS NULL OR ${t.after_id} <= ${t.epoch_upper_id}))`,
    ),
    check(
      "scheduler_sweep_lease_shape",
      sql`(${t.lease_owner_boot_id} IS NULL AND ${t.lease_token} IS NULL AND ${t.lease_until} IS NULL) OR (${t.lease_owner_boot_id} IS NOT NULL AND ${t.lease_token} IS NOT NULL AND ${t.lease_until} IS NOT NULL)`,
    ),
    check(
      "scheduler_sweep_lease_bound",
      sql`${t.lease_until} IS NULL OR (${t.lease_until} > ${t.updated_at} AND ${t.lease_until} <= ${t.updated_at} + interval '60 seconds')`,
    ),
  ],
);
