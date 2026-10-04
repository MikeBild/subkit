import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const discoveryRunStatusEnum = pgEnum("discovery_run_status", [
  "pending",
  "analyzing",
  "synthesizing",
  "completed",
  "failed",
]);

export const discoveryArtifactKindEnum = pgEnum("discovery_artifact_kind", [
  "connector",
  "skill",
  "knowledge_source",
  "capability_gap",
]);

export const discoveryArtifactStatusEnum = pgEnum("discovery_artifact_status", [
  "proposed",
  "approved",
  "rejected",
  "superseded",
]);

export const discoveryRuns = pgTable(
  "discovery_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    conversation_id: uuid("conversation_id"),
    status: discoveryRunStatusEnum("status").notNull().default("pending"),
    label: text("label"),
    file_count: integer("file_count").notNull().default(0),
    files_analyzed: integer("files_analyzed").notNull().default(0),
    artifact_count: integer("artifact_count").notNull().default(0),
    token_usage: jsonb("token_usage")
      .$type<{ prompt_tokens: number; completion_tokens: number; total_tokens: number }>()
      .default({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
    error: text("error"),
    started_at: timestamp("started_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("discovery_runs_tenant_status_idx").on(t.tenant_id, t.status)],
);

export const discoveryFiles = pgTable(
  "discovery_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    run_id: uuid("run_id")
      .notNull()
      .references(() => discoveryRuns.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mime_type: text("mime_type"),
    byte_size: integer("byte_size").notNull(),
    format: text("format").notNull(),
    content: text("content"),
    chunk_count: integer("chunk_count").notNull().default(0),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    fingerprint: text("fingerprint"),
    ...timestamps,
  },
  (t) => [index("discovery_files_run_idx").on(t.run_id)],
);

export const discoveryArtifacts = pgTable(
  "discovery_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    run_id: uuid("run_id")
      .notNull()
      .references(() => discoveryRuns.id, { onDelete: "cascade" }),
    kind: discoveryArtifactKindEnum("kind").notNull(),
    status: discoveryArtifactStatusEnum("status").notNull().default("proposed"),
    title: text("title").notNull(),
    description: text("description"),
    draft: jsonb("draft").notNull(),
    evidence: jsonb("evidence")
      .$type<{
        file_ids: string[];
        excerpts: Array<{ file_id: string; filename: string; text: string }>;
      }>()
      .notNull(),
    confidence: integer("confidence"),
    materialized_id: text("materialized_id"),
    materialized_type: text("materialized_type"),
    rejection_reason: text("rejection_reason"),
    ...timestamps,
  },
  (t) => [
    index("discovery_artifacts_run_kind_idx").on(t.run_id, t.kind),
    index("discovery_artifacts_tenant_status_idx").on(t.tenant_id, t.status),
  ],
);
