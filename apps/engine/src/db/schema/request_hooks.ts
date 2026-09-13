import { boolean, index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const requestHooks = pgTable(
  "request_hooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    source: text("source").notNull(),
    description: text("description"),
    updated_by: uuid("updated_by"),
    version: integer("version").notNull().default(1),
    enabled: boolean("enabled").default(true).notNull(),
    // sk-stdlib version at the time the hook was persisted. Read by the
    // self-healing drift detector to decide whether a major-bump
    // migration is needed. Null for rows created before stdlib tracking
    // was wired.
    stdlib_version: text("stdlib_version"),
    ...timestamps,
  },
  (t) => [index("request_hooks_tenant_role_version_idx").on(t.tenant_id, t.role, t.version)],
);
