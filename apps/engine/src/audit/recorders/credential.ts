// Credential audit recorders.
//
// Used by `saveConnectorAtomic` and `save_connector_draft` to log
// credential lifecycle events alongside the connector audit row.
// These recorders MUST NOT carry the credential value — only the mode
// + environment + the connector it belongs to.

import { auditAwait } from "../audit.ts";
import { AuditAction } from "../types.ts";
import { type RecordedEntry, type RecorderBase, resolveActorType } from "./types.ts";

export interface RecordCredentialAttachedParams extends RecorderBase {
  credential_id: string;
  connector_id: string;
  environment: string;
  mode: string;
  reason: string;
  source: "harness_auto_persist" | "tool_call" | "service";
}

export async function recordCredentialAttached(
  p: RecordCredentialAttachedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.CREDENTIAL_CREATED,
      resource_type: "credential",
      resource_id: p.credential_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source: p.source,
        connector_id: p.connector_id,
        environment: p.environment,
        mode: p.mode,
      },
    },
    p.executor,
  );
}

export interface RecordCredentialRotatedParams extends RecorderBase {
  credential_id: string;
  connector_id: string;
  environment: string;
  mode: string;
  reason: string;
  source: "harness_auto_persist" | "tool_call" | "service";
}

export async function recordCredentialRotated(
  p: RecordCredentialRotatedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.CREDENTIAL_ROTATED,
      resource_type: "credential",
      resource_id: p.credential_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source: p.source,
        connector_id: p.connector_id,
        environment: p.environment,
        mode: p.mode,
      },
    },
    p.executor,
  );
}

export interface RecordCredentialDeletedParams extends RecorderBase {
  credential_id: string;
  connector_id: string;
  environment: string;
  reason: string;
  source: "harness_auto_persist" | "tool_call" | "service";
}

export async function recordCredentialDeleted(
  p: RecordCredentialDeletedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.CREDENTIAL_DELETED,
      resource_type: "credential",
      resource_id: p.credential_id,
      result: "success",
      reason: p.reason,
      metadata: {
        source: p.source,
        connector_id: p.connector_id,
        environment: p.environment,
      },
    },
    p.executor,
  );
}
