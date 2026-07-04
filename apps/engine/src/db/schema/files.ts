// Unified files resource.
//
// One `files` table per tenant + polymorphic `file_links` join replaces
// the previously fragmented chat-attachment + knowledge-source upload
// storage. Every file the engine knows about — chat attachments, knowledge
// sources, workflow inputs (`$file` refs consumed by steps) and outputs
// (binary HTTP responses promoted by the request step, linked as
// `workflow_run`/`role: "output"`), discovery archives, skill artifacts —
// lands here. Dedup is sha256-scoped to the tenant; the lifecycle goes
// `pending -> uploading -> scanning -> ready | failed | expired`.
//
// Customer file bytes live exclusively in subkit's own object store —
// there is deliberately no provider-side (Files API) storage of customer
// files. The canonical shape is `{ "$file": "fid_<uuid>" }`;
// `subkit-file://<fid>` is the public locator.
//
// `file_links` is a thin polymorphic join. `resource_type` enumerates the
// owning subsystems, `resource_id` is the row id in that subsystem, and
// the optional `slug` lets the chat surface address an attachment by
// human-friendly name. The `tenant_id` column is denormalised onto every
// link row so every query path can scope by tenant without a join.

import {
  bigint,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

// ----- enums -----------------------------------------------------------------

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

// ----- files -----------------------------------------------------------------

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    status: fileStatusEnum("status").notNull().default("pending"),
    filename: text("filename").notNull(),
    content_type: text("content_type"),
    size_bytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    // Backend-specific URI. Local disk uses `local://<key>`; S3 uses
    // `s3://<bucket>/<key>`; legacy snapshots may carry `memory://`.
    storage_uri: text("storage_uri").notNull(),
    sha256: text("sha256"),
    upload_url_expires_at: timestamp("upload_url_expires_at", { withTimezone: true }),
    scan_result: text("scan_result"),
    created_by: uuid("created_by"),
    ...timestamps,
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("files_tenant_status_idx").on(t.tenant_id, t.status),
    uniqueIndex("files_tenant_sha256_uq").on(t.tenant_id, t.sha256),
  ],
);

// ----- file_links ------------------------------------------------------------

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
    // Human-friendly name (unique within the owning resource); powers
    // `@attachment:<slug>` chat-text rewriting at message ingest.
    slug: text("slug"),
    // Optional role/discriminator within the owning resource (e.g.
    // "attachment", "input", "output").
    role: text("role"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("file_links_tenant_resource_idx").on(t.tenant_id, t.resource_type, t.resource_id),
    uniqueIndex("file_links_conv_slug_uq").on(t.tenant_id, t.resource_type, t.resource_id, t.slug),
  ],
);

// ----- files_dedup_seen ------------------------------------------------------
//
// Per-tenant dedup-hit counter. UPSERT-bumped on every dedup short-circuit
// (inline path, batch-create, finalize sibling-dedup). One row per tenant
// — storage cost is constant. Powers the `dedup_hits` field on
// `GET /v1/files/stats` without reading `audit_log`, so the dashboard
// stat is independent of audit retention.

// One row per tenant; UPSERT-bumped from the inline + batch-create
// dedup paths. Never deleted directly — relies on ON DELETE CASCADE
// from tenants.id. No created_at: first-hit time is not currently a
// product requirement.
export const filesDedupSeen = pgTable("files_dedup_seen", {
  tenant_id: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  count: bigint("count", { mode: "number" }).notNull().default(0),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
