import { auditAwait } from "../audit.ts";
import { AuditAction } from "../types.ts";
import { type RecordedEntry, type RecorderBase, resolveActor } from "./types.ts";

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
      ...resolveActor(p),
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
  created?: boolean;
}

export async function recordKnowledgeSourceRefreshed(
  p: RecordKnowledgeSourceRefreshedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      ...resolveActor(p),
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

export interface RecordKnowledgeSourceCandidatesSynthesizedParams extends RecorderBase {
  knowledge_source_id: string;
  source_knowledge_source_id: string;
  candidate_count: number;
  endpoint_count: number;
  model_used: string;
  reason: string;
  created?: boolean;
}

export async function recordKnowledgeSourceCandidatesSynthesized(
  p: RecordKnowledgeSourceCandidatesSynthesizedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      ...resolveActor(p),
      action: AuditAction.KNOWLEDGE_SOURCE_CANDIDATES_SYNTHESIZED,
      resource_type: "knowledge_source",
      resource_id: p.knowledge_source_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source_knowledge_source_id: p.source_knowledge_source_id,
        candidate_count: p.candidate_count,
        endpoint_count: p.endpoint_count,
        model_used: p.model_used,
        ...(p.created !== undefined ? { created: p.created } : {}),
      },
    },
    p.executor,
  );
}
