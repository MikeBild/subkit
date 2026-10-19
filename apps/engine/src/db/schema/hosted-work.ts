import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const hostedWorkAdmissions = pgTable(
  "hosted_work_admissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id),
    kind: text("kind").$type<"execution" | "chat">().notNull(),
    state: text("state")
      .$type<"pending" | "active" | "reconciliation_required" | "released">()
      .notNull(),
    queue_name: text("queue_name"),
    job_id: uuid("job_id"),
    owner_boot_id: uuid("owner_boot_id").notNull(),
    evidence_sha256: text("evidence_sha256"),
    released_at: timestamp("released_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("hosted_work_admissions_job_key").on(t.tenant_id, t.queue_name, t.job_id),
    index("hosted_work_admissions_tenant_state_idx").on(t.tenant_id, t.kind, t.state),
    check("hosted_work_admissions_kind_check", sql`${t.kind} IN ('execution', 'chat')`),
    check(
      "hosted_work_admissions_state_check",
      sql`${t.state} IN ('pending', 'active', 'reconciliation_required', 'released')`,
    ),
    check(
      "hosted_work_admissions_job_check",
      sql`(${t.queue_name} IS NULL) = (${t.job_id} IS NULL) AND (${t.state} <> 'pending' OR ${t.job_id} IS NOT NULL)`,
    ),
    check(
      "hosted_work_admissions_release_check",
      sql`(${t.state} = 'released') = (${t.released_at} IS NOT NULL)`,
    ),
  ],
);
