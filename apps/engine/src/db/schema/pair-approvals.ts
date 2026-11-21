import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants, users } from "./identity.ts";

export type PairApprovalState =
  | "pending"
  | "approved"
  | "declined"
  | "withdrawn"
  | "expired"
  | "stale";

export type PairApprovalStaleReason = "manifest_changed" | "first_approver_unavailable";

export const workflowAuthorityPairRequests = pgTable(
  "workflow_authority_pair_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workflow_id: uuid("workflow_id").notNull(),
    workflow_version_id: uuid("workflow_version_id").notNull(),
    execution_environment: text("execution_environment").$type<"dev" | "prod">().notNull(),
    expected_manifest_digest: text("expected_manifest_digest").notNull(),
    grant: jsonb("grant").$type<Record<string, unknown>>().notNull(),
    first_approver_id: uuid("first_approver_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    second_approver_id: uuid("second_approver_id").references(() => users.id, {
      onDelete: "set null",
    }),
    state: text("state").$type<PairApprovalState>().default("pending").notNull(),
    stale_reason: text("stale_reason").$type<PairApprovalStaleReason>(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    decided_at: timestamp("decided_at", { withTimezone: true }),
    authority_id: uuid("authority_id"),
    ...timestamps,
  },
  (t) => [
    index("workflow_authority_pair_requests_state_idx").on(t.tenant_id, t.state),
    index("workflow_authority_pair_requests_workflow_idx").on(t.tenant_id, t.workflow_id),
    check(
      "workflow_authority_pair_requests_state_check",
      sql`${t.state} IN ('pending', 'approved', 'declined', 'withdrawn', 'expired', 'stale')`,
    ),
    check(
      "workflow_authority_pair_requests_environment_check",
      sql`${t.execution_environment} IN ('dev', 'prod')`,
    ),
    check(
      "workflow_authority_pair_requests_digest_check",
      sql`${t.expected_manifest_digest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "workflow_authority_pair_requests_two_people_check",
      sql`${t.second_approver_id} IS NULL OR ${t.second_approver_id} <> ${t.first_approver_id}`,
    ),
    check(
      "workflow_authority_pair_requests_approved_check",
      sql`(${t.state} = 'approved') = (${t.authority_id} IS NOT NULL AND ${t.second_approver_id} IS NOT NULL)`,
    ),
    check(
      "workflow_authority_pair_requests_stale_check",
      sql`(${t.state} = 'stale') = (${t.stale_reason} IS NOT NULL)`,
    ),
    check(
      "workflow_authority_pair_requests_grant_check",
      sql`jsonb_typeof(${t.grant}) = 'object' AND octet_length(${t.grant}::text) <= 4096`,
    ),
  ],
);

export type WorkflowAuthorityPairRequestRow = typeof workflowAuthorityPairRequests.$inferSelect;
