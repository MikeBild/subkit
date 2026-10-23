import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { catalogMetadata, catalogMetadataConstraints, tenantId, timestamps } from "./_common.ts";
import { auditActorKindEnum, tenants } from "./identity.ts";

export const fileStatusEnum = pgEnum("file_status", [
  "pending",
  "uploading",
  "scanning",
  "ready",
  "failed",
  "expired",
]);

export const fileLinkResourceEnum = pgEnum("file_link_resource", [
  "conversation",
  "knowledge_source",
  "skill",
  "connector",
  "workflow_run",
  "discovery_run",
]);

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    status: fileStatusEnum("status").notNull().default("pending"),
    filename: text("filename").notNull(),
    content_type: text("content_type"),
    size_bytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    storage_uri: text("storage_uri").notNull(),
    sha256: text("sha256"),
    upload_url_expires_at: timestamp("upload_url_expires_at", {
      withTimezone: true,
    }),
    scan_result: text("scan_result"),
    created_by: uuid("created_by"),
    slug: text("slug"),
    ...catalogMetadata(),
    ...timestamps,
    version: integer("version").notNull().default(1),
    restored_from: integer("restored_from"),
    replaced_at: timestamp("replaced_at", { withTimezone: true }),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("files_tenant_status_idx").on(t.tenant_id, t.status),
    uniqueIndex("files_tenant_sha256_uq").on(t.tenant_id, t.sha256),
    uniqueIndex("files_tenant_slug_uq")
      .on(t.tenant_id, t.slug)
      .where(sql`${t.slug} IS NOT NULL AND ${t.deleted_at} IS NULL`),
    ...catalogMetadataConstraints("files", t),
  ],
);

export const fileVersions = pgTable(
  "file_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    file_id: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    filename: text("filename").notNull(),
    content_type: text("content_type"),
    size_bytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storage_uri: text("storage_uri").notNull(),
    sha256: text("sha256"),
    restored_from: integer("restored_from"),
    uploaded_at: timestamp("uploaded_at", { withTimezone: true }).notNull(),
    uploaded_by_kind: auditActorKindEnum("uploaded_by_kind"),
    uploaded_by: uuid("uploaded_by"),
    replaced_at: timestamp("replaced_at", { withTimezone: true }).notNull(),
    replaced_by_kind: auditActorKindEnum("replaced_by_kind"),
    replaced_by: uuid("replaced_by"),
  },
  (t) => [
    uniqueIndex("file_versions_tenant_file_version_uq").on(t.tenant_id, t.file_id, t.version),
    check("file_versions_size_bytes_nonnegative", sql`${t.size_bytes} >= 0`),
  ],
);

export const fileLinks = pgTable(
  "file_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    file_id: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    resource_type: fileLinkResourceEnum("resource_type").notNull(),
    resource_id: uuid("resource_id").notNull(),
    slug: text("slug"),
    role: text("role"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("file_links_tenant_resource_idx").on(t.tenant_id, t.resource_type, t.resource_id),
    uniqueIndex("file_links_conv_slug_uq").on(t.tenant_id, t.resource_type, t.resource_id, t.slug),
  ],
);

export const filesDedupSeen = pgTable("files_dedup_seen", {
  tenant_id: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  count: bigint("count", { mode: "number" }).notNull().default(0),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
