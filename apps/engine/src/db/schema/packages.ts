import { index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { files } from "./files.ts";
import { tenants } from "./identity.ts";

export const packageInstalls = pgTable(
  "package_installs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    package_id: text("package_id").notNull(),
    package_version: text("package_version").notNull(),
    format: text("format").notNull(),
    content_digest: text("content_digest").notNull(),
    archive_file_id: uuid("archive_file_id").references(() => files.id, { onDelete: "set null" }),
    source: jsonb("source").$type<Record<string, unknown>>().notNull().default({}),
    installed_by_type: text("installed_by_type").notNull(),
    installed_by_id: uuid("installed_by_id"),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [index("package_installs_tenant_package_idx").on(t.tenant_id, t.package_id)],
);

export const packageInstallItems = pgTable(
  "package_install_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    install_id: uuid("install_id")
      .notNull()
      .references(() => packageInstalls.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    item_key: text("item_key").notNull(),
    local_id: uuid("local_id"),
    imported_hash: text("imported_hash").notNull(),
    local_hash: text("local_hash"),
    state: text("state").notNull(),
    intake_proposal_id: uuid("intake_proposal_id"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("package_install_items_tenant_item_key").on(t.tenant_id, t.kind, t.item_key),
    index("package_install_items_install_idx").on(t.tenant_id, t.install_id),
  ],
);
