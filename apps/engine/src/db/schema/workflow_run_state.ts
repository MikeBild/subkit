import { index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bytea, tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";
import { workflows } from "./workflows.ts";

export const workflowRunState = pgTable(
  "workflow_run_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workflow_id: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    auth_tag: bytea("auth_tag").notNull(),
    value_kind: text("value_kind"),
    note: jsonb("note").$type<Record<string, unknown> | null>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("workflow_run_state_tenant_workflow_key_uniq").on(
      t.tenant_id,
      t.workflow_id,
      t.key,
    ),
    index("workflow_run_state_tenant_workflow_idx").on(t.tenant_id, t.workflow_id),
  ],
);
