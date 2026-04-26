// Workflow audit recorders.
//
// Wave 3 paths:
//   - commitWorkflowAtomic / commit_draft → recordWorkflowCreated /
//     recordWorkflowUpdated (depending on whether the conversation had
//     a target_workflow_id pinned)
//   - commit_draft with force_commit override → recordWorkflowCommitted
//     with override=true so the commit_override row is the canonical
//     "force_commit happened" trail
//   - delete_workflow → recordWorkflowDeleted

import { auditAwait } from "../audit.ts";
import { AuditAction } from "../types.ts";
import { type RecordedEntry, type RecorderBase, resolveActorType } from "./types.ts";

export interface RecordWorkflowCreatedParams extends RecorderBase {
  workflow_id: string;
  slug: string;
  version: number | null;
  reason: string;
  source: "harness_auto_persist" | "tool_call" | "service";
  commit_intent_kind?: string;
}

export async function recordWorkflowCreated(
  p: RecordWorkflowCreatedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.WORKFLOW_CREATED,
      resource_type: "workflow",
      resource_id: p.workflow_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source: p.source,
        slug: p.slug,
        version: p.version,
        ...(p.commit_intent_kind ? { commit_intent_kind: p.commit_intent_kind } : {}),
      },
    },
    p.executor,
  );
}

export interface RecordWorkflowUpdatedParams extends RecorderBase {
  workflow_id: string;
  slug: string;
  version: number | null;
  workflow_version_id?: string | null;
  reason: string;
  source: "harness_auto_persist" | "tool_call" | "service";
  /** "commit_via_tool" | "auto_persist" | "preview_override" — surfaces in metadata. */
  kind?: string;
  tool?: string;
  commit_intent_kind?: string;
}

export async function recordWorkflowUpdated(
  p: RecordWorkflowUpdatedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.WORKFLOW_UPDATED,
      resource_type: "workflow",
      resource_id: p.workflow_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source: p.source,
        slug: p.slug,
        version: p.version,
        ...(p.workflow_version_id ? { workflow_version_id: p.workflow_version_id } : {}),
        ...(p.kind ? { kind: p.kind } : {}),
        ...(p.tool ? { tool: p.tool } : {}),
        ...(p.commit_intent_kind ? { commit_intent_kind: p.commit_intent_kind } : {}),
      },
    },
    p.executor,
  );
}

export interface RecordWorkflowDeletedParams extends RecorderBase {
  workflow_id: string;
  reason: string;
  source: "harness_auto_persist" | "tool_call" | "service";
  slug?: string;
}

export async function recordWorkflowDeleted(
  p: RecordWorkflowDeletedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.WORKFLOW_DELETED,
      resource_type: "workflow",
      resource_id: p.workflow_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source: p.source,
        ...(p.slug ? { slug: p.slug } : {}),
      },
    },
    p.executor,
  );
}

/**
 * Force-commit override record. Only emitted when `commit_draft` was
 * called with `force_commit: true` AND the most recent dry-run preview
 * was failing/missing. Mirrors the connector `saved_override` row.
 */
export interface RecordWorkflowCommittedParams extends RecorderBase {
  workflow_id: string;
  workflow_version_id?: string | null;
  version?: number | null;
  reason: string;
  source: "harness_auto_persist" | "tool_call";
  /** Captured preview summary so operators can see why the override fired. */
  latest_preview_summary?: unknown;
  latest_preview_warnings?: unknown[];
  tool?: string;
  /**
   * Override the metadata `kind` tag. Defaults to "force_commit_override"
   * (the Wave 4 canonical marker). The tool path passes
   * "preview_override" so the audit trail mirrors the existing
   * tooling vocabulary.
   */
  kind?: string;
}

export async function recordWorkflowCommitted(
  p: RecordWorkflowCommittedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.WORKFLOW_COMMITTED_OVERRIDE,
      resource_type: "workflow",
      resource_id: p.workflow_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source: p.source,
        kind: p.kind ?? "force_commit_override",
        ...(p.workflow_version_id ? { workflow_version_id: p.workflow_version_id } : {}),
        ...(p.version !== undefined ? { version: p.version } : {}),
        ...(p.latest_preview_summary !== undefined
          ? { latest_preview_summary: p.latest_preview_summary }
          : {}),
        ...(p.latest_preview_warnings !== undefined
          ? { latest_preview_warnings: p.latest_preview_warnings }
          : {}),
        ...(p.tool ? { tool: p.tool } : {}),
      },
    },
    p.executor,
  );
}
