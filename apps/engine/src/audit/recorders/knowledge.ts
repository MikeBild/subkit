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

/**
 * Audit row for `discover_systems_from_files`: the LLM analysed an
 * uploaded knowledge source (README, code dump, architecture PDF) and
 * synthesised provisional connector endpoint candidates. The persisted
 * row sits beside the source under
 * `kind = "connector_endpoint_candidates"` — this audit entry makes the
 * write visible to forensics and lets compliance filter on `reason =
 * "file_analysis"` to see when the LLM was used to fill an OpenAPI gap.
 */
export interface RecordKnowledgeSourceCandidatesSynthesizedParams extends RecorderBase {
  /** id of the `connector_endpoint_candidates` row that was just upserted. */
  knowledge_source_id: string;
  /** id of the source the LLM analysed (the original upload). */
  source_knowledge_source_id: string;
  /** Number of candidate connectors the LLM emitted. */
  candidate_count: number;
  /** Total number of provisional endpoints across all candidates. */
  endpoint_count: number;
  /** Model id the LLM call resolved to. */
  model_used: string;
  /** Reason: always `"file_analysis"` for this audit — kept on the
   *  param surface so callers can override if a different upstream
   *  trigger emerges. */
  reason: string;
  /** True when the row was newly inserted (vs. updated in place). */
  created?: boolean;
}

export async function recordKnowledgeSourceCandidatesSynthesized(
  p: RecordKnowledgeSourceCandidatesSynthesizedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
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
