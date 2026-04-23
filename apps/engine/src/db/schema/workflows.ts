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
    ...timestamps,
  },
  (t) => [index("workflows_schedules_tenant_workflow_idx").on(t.tenant_id, t.workflow_id)],
);
