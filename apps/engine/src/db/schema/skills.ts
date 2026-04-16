import { index, integer, jsonb, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const skillScopeEnum = pgEnum("skill_scope", ["global", "connector", "workflow"]);
export const skillLifecycleEnum = pgEnum("skill_lifecycle", ["draft", "active", "archived"]);

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    scope: skillScopeEnum("scope").notNull(),
    connector_id: uuid("connector_id"),
    workflow_id: uuid("workflow_id"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    examples: jsonb("examples"),
    // GC4: optional argument descriptors used by MCP completion/complete to
    // hint per-skill input names. Shape: [{name, description, enum?, default?}].
    arguments: jsonb("arguments"),
    lifecycle: skillLifecycleEnum("lifecycle").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    index("skills_tenant_scope_connector_idx").on(t.tenant_id, t.scope, t.connector_id),
    index("skills_tenant_scope_workflow_idx").on(t.tenant_id, t.scope, t.workflow_id),
  ],
);
