import { sql } from "drizzle-orm";
import {
  boolean,
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
import { tenantId, timestamps } from "./_common.ts";
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
    current_version_id: uuid("current_version_id"),
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
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
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
    index("workflow_versions_tenant_workflow_idx").on(t.tenant_id, t.workflow_id),
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
    input: jsonb("input"),
    // Reconciler dedup: timestamp of the most recent enqueue triggered
    // for this schedule. The reconciler refuses to enqueue again until
    // at least one cron period has elapsed since this stamp, so a
    // 10-minute outage cannot fan-out into 10 instant repeats of a
    // `* * * * *` schedule. NULL means "never fired" — first enqueue is
    // unconditional.
    last_enqueued_at: timestamp("last_enqueued_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("workflows_schedules_tenant_workflow_idx").on(t.tenant_id, t.workflow_id)],
);
