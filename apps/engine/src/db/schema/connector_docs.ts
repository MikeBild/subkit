import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId } from "./_common.ts";
import { connectors } from "./connectors.ts";
import { tenants } from "./identity.ts";

export const docSourceTypeEnum = pgEnum("doc_source_type", [
  "openapi",
  "google_discovery",
  "markdown",
  "llms_txt",
  "html",
  "graphql",
  "postgres",
  "file_upload",
]);

const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

export const connectorDocuments = pgTable(
  "connector_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    source_type: docSourceTypeEnum("source_type").notNull(),
    source_uri: text("source_uri").notNull(),
    version: text("version").notNull(),
    bytes_total: integer("bytes_total").notNull().default(0),
    chunk_count: integer("chunk_count").notNull().default(0),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("connector_documents_tenant_connector_idx").on(t.tenant_id, t.connector_id)],
);

export const connectorDocumentChunks = pgTable(
  "connector_document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    document_id: uuid("document_id")
      .notNull()
      .references(() => connectorDocuments.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    title: text("title"),
    path: text("path"),
    content: text("content").notNull(),
    byte_size: integer("byte_size").notNull(),
    fingerprint: text("fingerprint").notNull(),
    tsv: tsvector("tsv").generatedAlwaysAs(
      sql`to_tsvector('english', (((COALESCE(title, '') || ' ') || COALESCE(path, '')) || ' ') || content)`,
    ),
    embedding: real("embedding").array(),
    embedding_model: text("embedding_model"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("connector_document_chunks_tenant_connector_ordinal_idx").on(
      t.tenant_id,
      t.connector_id,
      t.ordinal,
    ),
    index("connector_document_chunks_tsv_idx").using("gin", t.tsv),
  ],
);
