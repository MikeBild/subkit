import { sql } from "drizzle-orm";
import { check, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { executionModeEnum, tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";
import { workflows } from "./workflows.ts";

export const ownedResources = pgTable(
  "owned_resources",
  {
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workflow_id: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    environment: executionModeEnum("environment").notNull(),
    connector_id: uuid("connector_id").notNull(),
    collection_path: text("collection_path").notNull(),
    resource_key: text("resource_key").notNull(),
    workflow_version_id: uuid("workflow_version_id").notNull(),
    created_execution_id: uuid("created_execution_id").notNull(),
    created_step_id: text("created_step_id").notNull(),
    deleted_execution_id: uuid("deleted_execution_id"),
    deleted_step_id: text("deleted_step_id"),
    state: text("state")
      .$type<"owned" | "deleting" | "deleted" | "delete_unknown">()
      .notNull()
      .default("owned"),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      name: "owned_resources_pk",
      columns: [
        table.tenant_id,
        table.workflow_id,
        table.environment,
        table.connector_id,
        table.collection_path,
        table.resource_key,
      ],
    }),
    check(
      "owned_resources_state_check",
      sql`${table.state} IN ('owned', 'deleting', 'deleted', 'delete_unknown')`,
    ),
    check(
      "owned_resources_collection_path_check",
      sql`char_length(${table.collection_path}) BETWEEN 1 AND 2048`,
    ),
    check(
      "owned_resources_resource_key_check",
      sql`char_length(${table.resource_key}) BETWEEN 1 AND 1024`,
    ),
  ],
);
