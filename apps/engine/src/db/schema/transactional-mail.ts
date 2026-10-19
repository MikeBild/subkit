import { pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";
import { workflows } from "./workflows.ts";

export const transactionalMailReceipts = pgTable(
  "transactional_mail_receipts",
  {
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workflow_id: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    request_id: uuid("request_id").notNull(),
    execution_id: uuid("execution_id").notNull(),
    step_id: text("step_id").notNull(),
    state: text("state").$type<"attempted" | "sent" | "failed" | "delivery_unknown">().notNull(),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.tenant_id, table.workflow_id, table.request_id] })],
);
