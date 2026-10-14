import type { RequestSource } from "../../observability/service-metadata.ts";
import { auditAwait } from "../audit.ts";
import { AuditAction } from "../types.ts";
import { type RecordedEntry, type RecorderBase, resolveActor } from "./types.ts";

export interface RecordChatPaletteSurfaceEnforcedParams extends RecorderBase {
  conversation_id: string;
  request_source: RequestSource;
}

export async function recordChatPaletteSurfaceEnforced(
  p: RecordChatPaletteSurfaceEnforcedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      ...resolveActor(p),
      action: AuditAction.CONVERSATION_PALETTE_SURFACE_ENFORCED,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "success",
      reason: "chat_provider_without_chat_surface",
      metadata: {
        conversation_id: p.conversation_id,
        request_source: p.request_source,
        palette: "chat_read_only",
      },
    },
    p.executor,
  );
}

export interface RecordToolPolicyConfirmationRequiredParams extends RecorderBase {
  conversation_id: string;
  tool: string;
  mode: string;
  confirmation_kind: string | null;
  resolver_reason: string | null;
  environment?: string | null;
}

export async function recordToolPolicyConfirmationRequired(
  p: RecordToolPolicyConfirmationRequiredParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      ...resolveActor(p),
      action: AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "denied",
      reason: "confirm_before_execution",
      metadata: {
        conversation_id: p.conversation_id,
        tool: p.tool,
        mode: p.mode,
        confirmation_kind: p.confirmation_kind,
        resolver_reason: p.resolver_reason,
        ...(p.environment !== undefined ? { environment: p.environment } : {}),
      },
    },
    p.executor,
  );
}
