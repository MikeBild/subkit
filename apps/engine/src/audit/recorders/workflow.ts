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
  forced_over_runtime_data?: boolean;
  preview_failure_class?: string;
  bypassed_prior_approval?: boolean;
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
        ...(p.forced_over_runtime_data
          ? {
              forced_over_runtime_data: true,
              ...(p.preview_failure_class
                ? { preview_failure_class: p.preview_failure_class }
                : {}),
            }
          : {}),
        ...(p.bypassed_prior_approval ? { bypassed_prior_approval: true } : {}),
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
  kind?: string;
  tool?: string;
  commit_intent_kind?: string;
  forced_over_runtime_data?: boolean;
  preview_failure_class?: string;
  bypassed_prior_approval?: boolean;
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
        ...(p.forced_over_runtime_data
          ? {
              forced_over_runtime_data: true,
              ...(p.preview_failure_class
                ? { preview_failure_class: p.preview_failure_class }
                : {}),
            }
          : {}),
        ...(p.bypassed_prior_approval ? { bypassed_prior_approval: true } : {}),
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

export interface RecordWorkflowCommittedParams extends RecorderBase {
  workflow_id: string;
  workflow_version_id?: string | null;
  version?: number | null;
  reason: string;
  source: "harness_auto_persist" | "tool_call";
  latest_preview_summary?: unknown;
  latest_preview_warnings?: unknown[];
  tool?: string;
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
        kind: p.kind ?? "force_save_override",
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

export interface RecordWorkflowScheduleNotBoundParams extends RecorderBase {
  workflow_id: string;
  slug: string;
  matched_phrases: string[];
}

export async function recordWorkflowScheduleNotBound(
  p: RecordWorkflowScheduleNotBoundParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.WORKFLOW_SCHEDULE_NOT_BOUND,
      resource_type: "workflow",
      resource_id: p.workflow_id,
      result: "success",
      metadata: {
        kind: "warning",
        slug: p.slug,
        matched_phrases: p.matched_phrases,
      },
    },
    p.executor,
  );
}
