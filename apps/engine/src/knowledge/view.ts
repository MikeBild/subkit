import type { knowledgeSources } from "../db/schema/knowledge_sources.ts";
import type { KnowledgeSourceView } from "./types.ts";

export function knowledgeSourceRowToView(
  row: typeof knowledgeSources.$inferSelect,
): KnowledgeSourceView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    tags: row.tags,
    scope: row.scope,
    workflow_id: row.workflow_id,
    status: row.status,
    last_error: row.last_error,
    source_type: row.source_type,
    source_uri: row.source_uri,
    mime_type: row.mime_type,
    version: row.version,
    bytes_total: row.bytes_total,
    chunk_count: row.chunk_count,
    refresh_strategy: row.refresh_strategy,
    refresh_cron: row.refresh_cron,
    last_refreshed_at: row.last_refreshed_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
