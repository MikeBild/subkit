import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const tenantErasureStates = pgTable("tenant_erasure_states", {
  tenant_id: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id),
  stage: text("stage")
    .$type<"claimed" | "queue_cleared" | "objects_cleared" | "completed">()
    .notNull()
    .default("claimed"),
  lease_owner: uuid("lease_owner"),
  lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  failure_code: text("failure_code"),
  drain_boot_id: text("drain_boot_id"),
  drain_untracked: boolean("drain_untracked").notNull().default(false),
  completed_at: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
});
