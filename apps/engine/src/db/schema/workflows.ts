import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  catalogMetadata,
  catalogMetadataConstraints,
  executionModeEnum,
  tenantId,
  timestamps,
} from "./_common.ts";
import { conversations } from "./conversations.ts";
import { tenants } from "./identity.ts";

export const autohealPolicyEnum = pgEnum("autoheal_policy", [
  "safe-patches",
  "never-auto",
  "dry-run-gate",
]);

export const workflowLifecycleEnum = pgEnum("workflow_lifecycle", ["draft", "active", "archived"]);

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    ...catalogMetadata(),
    current_version_id: uuid("current_version_id"),
    draft_version_id: uuid("draft_version_id"),
    lifecycle: workflowLifecycleEnum("lifecycle").notNull(),
    is_tool: boolean("is_tool").notNull().default(true),
    last_executed_at: timestamp("last_executed_at", { withTimezone: true }),
    health_state: text("health_state").notNull().default("ok"),
    health_reason: text("health_reason"),
    health_changed_at: timestamp("health_changed_at", { withTimezone: true }),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("workflows_tenant_id_key").on(t.tenant_id, t.id),
    uniqueIndex("workflows_tenant_slug_active_key")
      .on(t.tenant_id, t.slug)
      .where(sql`${t.deleted_at} IS NULL`),
    index("workflows_tool_catalog_lru_idx")
      .on(t.tenant_id, t.last_executed_at.desc(), t.created_at)
      .where(sql`${t.is_tool} = TRUE AND ${t.deleted_at} IS NULL`),
    ...catalogMetadataConstraints("workflows", t),
  ],
);

export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workflow_id: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    dag: jsonb("dag").notNull(),
    spec: jsonb("spec").$type<Record<string, unknown>>(),
    author_user_id: uuid("author_user_id"),
    author_system_account_id: uuid("author_system_account_id"),
    note: text("note"),
    authority_growth: jsonb("authority_growth").$type<Record<string, unknown>>(),
    scope_index:
      jsonb("scope_index").$type<
        Record<
          string,
          { available_paths: string[]; shape_summary: string; primary_data_path: string | null }
        >
      >(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("workflow_versions_workflow_version_key").on(t.workflow_id, t.version),
    uniqueIndex("workflow_versions_tenant_workflow_id_key").on(t.tenant_id, t.workflow_id, t.id),
    index("workflow_versions_tenant_workflow_idx").on(t.tenant_id, t.workflow_id),
  ],
);

export const workflowExecutionAuthorities = pgTable(
  "workflow_execution_authorities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workflow_id: uuid("workflow_id").notNull(),
    workflow_version_id: uuid("workflow_version_id").notNull(),
    effect_manifest_digest: text("effect_manifest_digest").notNull(),
    effect_manifest: jsonb("effect_manifest").$type<Record<string, unknown>>().notNull(),
    execution_environment: executionModeEnum("execution_environment").notNull(),
    target_constraints: jsonb("target_constraints").$type<{ targets: string[] }>().notNull(),
    valid_from: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    valid_until: timestamp("valid_until", { withTimezone: true }),
    max_runs: integer("max_runs"),
    reserved_runs: integer("reserved_runs").notNull().default(0),
    created_by: uuid("created_by").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    revoked_by: uuid("revoked_by"),
    inherited_from: uuid("inherited_from"),
    superseded_by: uuid("superseded_by"),
    approved_manifest: jsonb("approved_manifest").$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex("workflow_authorities_tenant_id_key").on(t.tenant_id, t.id),
    uniqueIndex("workflow_authorities_execution_binding_key").on(
      t.tenant_id,
      t.id,
      t.workflow_id,
      t.workflow_version_id,
      t.execution_environment,
    ),
    uniqueIndex("workflow_authorities_inherited_from_key")
      .on(t.tenant_id, t.inherited_from)
      .where(sql`${t.inherited_from} IS NOT NULL`),
    foreignKey({
      name: "workflow_authorities_inherited_from_fk",
      columns: [t.tenant_id, t.inherited_from],
      foreignColumns: [t.tenant_id, t.id],
    }).onDelete("restrict"),
    index("workflow_authorities_boundary_idx")
      .on(t.tenant_id, t.workflow_id, t.workflow_version_id, t.execution_environment)
      .where(sql`${t.revoked_at} IS NULL`),
    foreignKey({
      name: "workflow_authorities_tenant_workflow_fk",
      columns: [t.tenant_id, t.workflow_id],
      foreignColumns: [workflows.tenant_id, workflows.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "workflow_authorities_exact_version_fk",
      columns: [t.tenant_id, t.workflow_id, t.workflow_version_id],
      foreignColumns: [
        workflowVersions.tenant_id,
        workflowVersions.workflow_id,
        workflowVersions.id,
      ],
    }).onDelete("restrict"),
    check("workflow_authorities_digest_check", sql`${t.effect_manifest_digest} ~ '^[0-9a-f]{64}$'`),
    check(
      "workflow_authorities_window_check",
      sql`${t.valid_until} IS NULL OR ${t.valid_until} > ${t.valid_from}`,
    ),
    check(
      "workflow_authorities_run_limit_check",
      sql`${t.reserved_runs} >= 0 AND (${t.max_runs} IS NULL OR (${t.max_runs} > 0 AND ${t.reserved_runs} <= ${t.max_runs}))`,
    ),
    check(
      "workflow_authorities_manifest_check",
      sql`jsonb_typeof(${t.effect_manifest}) = 'object'`,
    ),
    check(
      "workflow_authorities_targets_check",
      sql`jsonb_typeof(${t.target_constraints}) = 'object' AND ${t.target_constraints} ? 'targets' AND jsonb_typeof(${t.target_constraints}->'targets') = 'array'`,
    ),
    check(
      "workflow_authorities_revocation_check",
      sql`(${t.revoked_at} IS NULL AND ${t.revoked_by} IS NULL AND ${t.superseded_by} IS NULL) OR (${t.revoked_at} IS NOT NULL AND (${t.revoked_by} IS NOT NULL OR ${t.superseded_by} IS NOT NULL))`,
    ),
  ],
);

export const workflowReviewReceipts = pgTable(
  "workflow_review_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workflow_id: uuid("workflow_id").references(() => workflows.id, { onDelete: "cascade" }),
    conversation_id: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    prepared_by: uuid("prepared_by").notNull(),
    session_id: uuid("session_id").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    snapshot_digest: text("snapshot_digest").notNull(),
    status: text("status").notNull().default("pending"),
    authority_id: uuid("authority_id"),
    schedule_id: uuid("schedule_id"),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    index("workflow_review_receipts_tenant_workflow_idx").on(t.tenant_id, t.workflow_id),
    index("workflow_review_receipts_tenant_conversation_idx").on(t.tenant_id, t.conversation_id),
    index("workflow_review_receipts_expiry_idx")
      .on(t.expires_at)
      .where(sql`${t.status} = 'pending'`),
    foreignKey({
      name: "workflow_review_receipts_tenant_workflow_fk",
      columns: [t.tenant_id, t.workflow_id],
      foreignColumns: [workflows.tenant_id, workflows.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "workflow_review_receipts_tenant_authority_fk",
      columns: [t.tenant_id, t.authority_id],
      foreignColumns: [workflowExecutionAuthorities.tenant_id, workflowExecutionAuthorities.id],
    }).onDelete("cascade"),
    check("workflow_review_receipts_status_check", sql`${t.status} IN ('pending', 'completed')`),
    check("workflow_review_receipts_digest_check", sql`${t.snapshot_digest} ~ '^[0-9a-f]{64}$'`),
    check(
      "workflow_review_receipts_completion_check",
      sql`(${t.status} = 'pending' AND ${t.completed_at} IS NULL) OR (${t.status} = 'completed' AND ${t.completed_at} IS NOT NULL)`,
    ),
  ],
);

export const workflowAutohealPolicies = pgTable(
  "workflow_autoheal_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workflow_id: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    policy: autohealPolicyEnum("policy").notNull().default("safe-patches"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("workflow_autoheal_policies_workflow_key").on(t.workflow_id),
    index("workflow_autoheal_policies_tenant_idx").on(t.tenant_id),
  ],
);

export const workflowsSchedules = pgTable(
  "workflows_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workflow_id: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    cron: text("cron").notNull(),
    timezone: text("timezone").default("UTC").notNull(),
    paused: boolean("paused").default(false).notNull(),
    execution_mode: executionModeEnum("execution_mode").default("prod").notNull(),
    input: jsonb("input"),
    admission_hold: jsonb("admission_hold").$type<{
      reason_code:
        | "execution_authority_required"
        | "execution_authority_unavailable"
        | "input_required";
      observed_at: string;
    }>(),
    input_error: jsonb("input_error").$type<{
      checked_version_id: string;
      issues: { path: string; message: string }[];
    }>(),
    last_enqueued_at: timestamp("last_enqueued_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("workflows_schedules_tenant_workflow_uidx").on(t.tenant_id, t.workflow_id)],
);
