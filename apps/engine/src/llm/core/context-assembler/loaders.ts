// DB-side loaders for the context assembler. Each helper is best-
// effort: a DB blip never blocks prompt assembly — the caller gets an
// empty array and the assembled prompt simply omits the section.

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../../db/client.ts";
import { conversationElicitations, conversations } from "../../../db/schema/index.ts";
import { searchDocs } from "../../../docs-ingestion/service.ts";
import { searchKnowledge } from "../../../knowledge/service.ts";
import { logger } from "../../../logging/logger.ts";
import { countTokens } from "../../accounting/index.ts";
import type { IncludedChunk, IncludedKnowledgeChunk } from "../../types.ts";

export type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface InteractionLogEntry {
  tool_name: string;
  status: string;
  decision: string;
  decision_reason: string | null;
  decided_at: Date | null;
}

/** Compact preview entry surfaced to the model. */
export interface LatestPreviewEntry {
  step_id: string;
  kind: string;
  status: string;
  shape_summary?: string;
  primary_data_path?: string | null;
  available_paths?: string[];
  error_code?: string;
}

/**
 * Load the last N elicitations for a conversation in reverse-chronological
 * order, then reverse to chronological for display. We only surface
 * resolved/cancelled/timeout entries — pending elicitations are still
 * waiting for the user, so reading them as "decisions" would be wrong.
 *
 * Returns at most `limit` entries; conservative because the LLM only
 * needs the recent confirmation history, not the full audit trail.
 */
export async function loadInteractionLog(
  tenant_id: string,
  conversation_id: string,
  exec: Executor,
  limit = 10,
): Promise<InteractionLogEntry[]> {
  try {
    const rows = await exec
      .select({
        tool_name: conversationElicitations.tool_name,
        status: conversationElicitations.status,
        output: conversationElicitations.output,
        decision_reason: conversationElicitations.decision_reason,
        decided_at: conversationElicitations.decided_at,
      })
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, tenant_id),
          eq(conversationElicitations.conversation_id, conversation_id),
        ),
      )
      .orderBy(desc(conversationElicitations.created_at))
      .limit(limit);
    const filtered = rows.filter((r) => r.status !== "pending");
    return filtered.reverse().map((r) => {
      const output = r.output as Record<string, unknown> | null;
      const confirmed = output?.confirmed === true;
      const partial = Array.isArray(output?.approved_indices);
      const decision = partial
        ? "partial"
        : confirmed
          ? "approved"
          : r.status === "resolved"
            ? "declined"
            : r.status;
      return {
        tool_name: r.tool_name,
        status: r.status,
        decision,
        decision_reason: r.decision_reason,
        decided_at: r.decided_at,
      };
    });
  } catch (err) {
    logger.warn({
      module: "llm",
      action: "llm.context.interaction_log_skipped",
      msg: "interaction log query failed; prompt assembled without it",
      tenant_id,
      conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Read the most recent dry-run / run preview off the conversation's
 * persisted draft (`conversations.draft.latest_preview.step_traces`).
 * Compacted to step_id + kind + status + scope_at_step. The
 * authoring loop will reach for this before guessing a JSONata path
 * — no need to re-issue a dry_run just to remember the shape.
 */
export async function loadLatestPreview(
  tenant_id: string,
  conversation_id: string,
  exec: Executor,
  limit = 12,
): Promise<LatestPreviewEntry[]> {
  try {
    const rows = await exec
      .select({ draft: conversations.draft })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
      .limit(1);
    const draft = rows[0]?.draft as
      | {
          latest_preview?: {
            step_traces?: Array<Record<string, unknown>>;
          };
        }
      | null
      | undefined;
    const traces = draft?.latest_preview?.step_traces;
    if (!Array.isArray(traces)) return [];
    const out: LatestPreviewEntry[] = [];
    for (const t of traces.slice(0, limit)) {
      if (!t || typeof t !== "object") continue;
      const stepId = (t as { step_id?: unknown }).step_id;
      const kind = (t as { kind?: unknown }).kind;
      const status = (t as { status?: unknown }).status;
      if (typeof stepId !== "string") continue;
      const scope = (t as { scope_at_step?: Record<string, unknown> }).scope_at_step;
      const errorCode = (t as { error_code?: unknown }).error_code;
      out.push({
        step_id: stepId,
        kind: typeof kind === "string" ? kind : "unknown",
        status: typeof status === "string" ? status : "unknown",
        ...(scope && typeof scope.shape_summary === "string"
          ? { shape_summary: scope.shape_summary }
          : {}),
        ...(scope &&
        (typeof scope.primary_data_path === "string" || scope.primary_data_path === null)
          ? { primary_data_path: scope.primary_data_path as string | null }
          : {}),
        ...(scope && Array.isArray(scope.available_paths)
          ? {
              available_paths: (scope.available_paths as unknown[])
                .filter((s): s is string => typeof s === "string")
                .slice(0, 8),
            }
          : {}),
        ...(typeof errorCode === "string" ? { error_code: errorCode } : {}),
      });
    }
    return out;
  } catch (err) {
    logger.warn({
      module: "llm",
      action: "llm.context.latest_preview_skipped",
      msg: "latest-preview query failed; prompt assembled without it",
      tenant_id,
      conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function loadChunks(
  tenant_id: string,
  connector_id: string | undefined,
  query: string,
  exec: Executor,
): Promise<IncludedChunk[]> {
  if (!connector_id || !query) return [];
  try {
    const hits = await searchDocs({ tenant_id, connector_id, query, limit: 10 }, exec);
    return hits.map((h) => ({
      id: h.id,
      document_id: h.document_id,
      title: h.title,
      path: h.path,
      snippet: h.snippet,
      rank: h.rank,
      tokens: countTokens(h.snippet),
      fetched_at: h.fetched_at,
    }));
  } catch (err) {
    logger.debug({
      module: "llm",
      action: "llm.context.doc_search_skipped",
      msg: "doc search failed during context assembly",
      tenant_id,
      connector_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function loadKnowledgeChunks(
  tenant_id: string,
  workflow_id: string | undefined,
  query: string,
  exec: Executor,
): Promise<IncludedKnowledgeChunk[]> {
  if (!query) return [];
  try {
    const hits = await searchKnowledge(
      { tenant_id, query, ...(workflow_id ? { workflow_id } : {}), limit: 10 },
      exec,
    );
    return hits.map((h) => ({
      id: h.id,
      knowledge_source_id: h.knowledge_source_id,
      title: h.title,
      path: h.path,
      snippet: h.snippet,
      rank: h.rank,
      tokens: countTokens(h.snippet),
      fetched_at: h.fetched_at,
    }));
  } catch (err) {
    logger.debug({
      module: "llm",
      action: "llm.context.knowledge_search_skipped",
      msg: "knowledge search failed during context assembly",
      tenant_id,
      workflow_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
