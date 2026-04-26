// Knowledge-source audit recorders.
//
// `discover_connector_endpoints` writes a `knowledge_sources` row when
// it caches discovery output. The audit row makes the cache write
// visible to forensics; metadata captures cache key + endpoint count
// so operators can audit "which connectors did discovery touch this
// week" without scraping logs.

import { auditAwait } from "../audit.ts";
import { AuditAction } from "../types.ts";
import { type RecordedEntry, type RecorderBase, resolveActorType } from "./types.ts";

export interface RecordKnowledgeSourceCreatedParams extends RecorderBase {
  knowledge_source_id: string;
  source_type: string;
  source_uri: string;
  cache_key?: string;
  reason: string;
  endpoint_count?: number;
  strategy?: string;
}

export async function recordKnowledgeSourceCreated(
  p: RecordKnowledgeSourceCreatedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.KNOWLEDGE_SOURCE_CREATED,
      resource_type: "knowledge_source",
      resource_id: p.knowledge_source_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source_type: p.source_type,
        source_uri: p.source_uri,
        ...(p.cache_key ? { cache_key: p.cache_key } : {}),
        ...(p.endpoint_count !== undefined ? { endpoint_count: p.endpoint_count } : {}),
        ...(p.strategy ? { strategy: p.strategy } : {}),
      },
    },
    p.executor,
  );
}

export interface RecordKnowledgeSourceRefreshedParams extends RecorderBase {
  knowledge_source_id: string;
  source_type: string;
  source_uri: string;
  cache_key?: string;
  reason: string;
  endpoint_count?: number;
  strategy?: string;
  /** True when this refresh produced a brand-new knowledge_sources row. */
  created?: boolean;
}

export async function recordKnowledgeSourceRefreshed(
  p: RecordKnowledgeSourceRefreshedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.KNOWLEDGE_SOURCE_REFRESHED,
      resource_type: "knowledge_source",
      resource_id: p.knowledge_source_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source_type: p.source_type,
        source_uri: p.source_uri,
        ...(p.cache_key ? { cache_key: p.cache_key } : {}),
        ...(p.endpoint_count !== undefined ? { endpoint_count: p.endpoint_count } : {}),
        ...(p.strategy ? { strategy: p.strategy } : {}),
        ...(p.created !== undefined ? { created: p.created } : {}),
      },
    },
    p.executor,
  );
}
