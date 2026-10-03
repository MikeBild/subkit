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
import { executionModeEnum, tenantId, timestamps } from "./_common.ts";
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
    // First-class, editable workflow description. Canonical source for the
    // LLM-facing `wf_<slug>` tool description: the catalog
    // (apps/engine/src/workflows/catalog.ts) prefers this column, then the
    // DAG's `WorkflowDef.description`, then `name`. Patchable as metadata
    // via `update_workflow` with no version bump — the DAG carries an
    // authoring-time `description` too, but editing the surface text must
    // not force a new version. Nullable so existing rows survive unchanged
    // and fall through to the DAG/name fallback.
    description: text("description"),
    current_version_id: uuid("current_version_id"),
    // Authoring never moves the executable pointer. Draft versions are inert
    // until an explicit, version-bound activation promotes them.
    draft_version_id: uuid("draft_version_id"),
    lifecycle: workflowLifecycleEnum("lifecycle").notNull(),
    // Product-catalog flag: if true AND current_version_id is set AND
    // deleted_at is NULL, this workflow appears in the MCP tools/list
    // catalog as a first-class product tool. Authoring-only workflows can
    // flip this to false to hide from the product surface.
    is_tool: boolean("is_tool").notNull().default(true),
    // Last `runExecution({ source: { kind: "saved", workflow_id } })`
    // timestamp. Drives the LRU cap on the `wf_<slug>` tool catalog
    // exposed to chat + MCP — tenants with hundreds of workflows ship
    // their 40 most-recently-used to the LLM palette; the rest are
    // reachable via the always-available `run_workflow(workflow=<slug>)`
    // fallback. Null until the first run lands.
    last_executed_at: timestamp("last_executed_at", { withTimezone: true }),
    // Rolled-up workflow health: ok | needs_attention | degraded. Flipped to
    // needs_attention when a connector this workflow depends on becomes
    // unusable (needs_update/needs_reauth) or a preflight/contract probe
    // fails — so the operator learns BEFORE an unattended run yields
    // "0 results". Written only through connectors/health-state.ts.
    health_state: text("health_state").notNull().default("ok"),
    health_reason: text("health_reason"),
    health_changed_at: timestamp("health_changed_at", { withTimezone: true }),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("workflows_tenant_id_key").on(t.tenant_id, t.id),
    // Partial unique: soft-deleted rows must not block their slug. Without
    // this, `delete_workflow` + re-create with the same slug fails with
    // 23505 even though the live tenant has no such workflow anymore.
    uniqueIndex("workflows_tenant_slug_active_key")
      .on(t.tenant_id, t.slug)
      .where(sql`${t.deleted_at} IS NULL`),
    // The `wf_<slug>` tool catalog (apps/engine/src/workflows/catalog.ts)
    // orders by `last_executed_at DESC NULLS LAST, created_at ASC` and
    // caps at 40 per principal. For tenants with thousands of workflows
    // the planner would otherwise scan. Migration
    // `0031_workflows_catalog_lru_index.sql` is the source of truth for
    // the `WHERE is_tool=TRUE AND deleted_at IS NULL` partial clause;
    // drizzle-kit does not express that cleanly today, so we declare the
    // unfiltered ordering here and let the migration own the partial
    // predicate. A future drizzle-kit run will see this declaration and
    // emit nothing — the partial index already exists.
    index("workflows_tool_catalog_lru_idx")
      .on(t.tenant_id, t.last_executed_at.desc(), t.created_at)
      .where(sql`${t.is_tool} = TRUE AND ${t.deleted_at} IS NULL`),
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
    author_user_id: uuid("author_user_id"),
    author_system_account_id: uuid("author_system_account_id"),
    note: text("note"),
    // Why the running version's approval did not follow this version, per
    // environment: what its effect boundary adds. Written when this version
    // became active and an approval could not continue; NULL otherwise.
    authority_growth: jsonb("authority_growth").$type<Record<string, unknown>>(),
    // Compact `step_id → scope_at_step` map captured from the most
    // recent dry_run / run before this version was committed. Lets
    // a follow-up authoring session populate `inspect_workflow` and
    // `suggest_jsonata_paths` without re-running the workflow.
    // Shape: { [stepId]: { available_paths, shape_summary,
    //                      primary_data_path } }
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

// Activation alone grants no repeated runs. This separate, finite boundary is
// checked by the owning product and never inferred from another product's grant.
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
    // NULL: no end date — the grant stands until it is revoked.
    valid_until: timestamp("valid_until", { withTimezone: true }),
    // NULL: no run limit. Runs are still counted in `reserved_runs`.
    max_runs: integer("max_runs"),
    reserved_runs: integer("reserved_runs").notNull().default(0),
    created_by: uuid("created_by").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    revoked_by: uuid("revoked_by"),
    // The grant this one continues for a newer version whose effect boundary
    // did not grow. NULL for a grant a person gave directly.
    inherited_from: uuid("inherited_from"),
    // The grant that continued this one. Set together with `revoked_at` when a
    // newer version took the remaining allowance over, so it is never doubled.
    superseded_by: uuid("superseded_by"),
    // The effect manifest a person approved. An inherited grant carries its
    // parent's, so a chain of versions is always measured against what a
    // person looked at. NULL on a grant given before inheritance existed: its
    // own `effect_manifest` is that boundary.
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
    // A grant is continued at most once: two activations racing for the same
    // parent cannot both take its remaining allowance.
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
    // Unattended automation is production by default. Dev remains explicit
    // for rapid `every:N` authoring loops and test schedules.
    execution_mode: executionModeEnum("execution_mode").default("prod").notNull(),
    input: jsonb("input"),
    // Reconciler dedup: timestamp of the most recent enqueue triggered
    // for this schedule. The reconciler refuses to enqueue again until
    // at least one cron period has elapsed since this stamp, so a
    // 10-minute outage cannot fan-out into 10 instant repeats of a
    // `* * * * *` schedule. NULL means "never fired" — first enqueue is
    // unconditional.
    admission_hold: jsonb("admission_hold").$type<{
      reason_code: "execution_authority_required" | "execution_authority_unavailable";
      observed_at: string;
    }>(),
    last_enqueued_at: timestamp("last_enqueued_at", { withTimezone: true }),
    ...timestamps,
  },
  // One schedule row per workflow. The reconciler fires each row
  // independently, so duplicate rows for the same workflow multiply into
  // extra runs. Both write paths (`bindFromWorkflow` and `createSchedule`)
  // update-or-insert on (tenant_id, workflow_id); the unique index makes the
  // invariant impossible to violate even under a concurrent-insert race.
  (t) => [uniqueIndex("workflows_schedules_tenant_workflow_uidx").on(t.tenant_id, t.workflow_id)],
);
