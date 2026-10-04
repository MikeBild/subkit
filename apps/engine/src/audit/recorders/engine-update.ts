import type { Executor } from "../../db/client.ts";
import { auditAwait } from "../audit.ts";
import { AuditAction, EngineUpdateMetadataSchema, SYSTEM_TENANT_ID } from "../types.ts";
import type { RecordedEntry } from "./types.ts";

interface EngineUpdateBase {
  executor?: Executor;
  from_version: string;
  to_version: string;
  channel: "stable" | "beta";
  request_source: "self-update" | "rollback";
}

const SYSTEM_ACTOR = {
  tenant_id: SYSTEM_TENANT_ID,
  actor_type: "system" as const,
  actor_id: null,
};

export interface RecordEngineUpdateInitiatedParams extends EngineUpdateBase {
  reason?: string;
}

export async function recordEngineUpdateInitiated(
  p: RecordEngineUpdateInitiatedParams,
): Promise<RecordedEntry> {
  const metadata = EngineUpdateMetadataSchema.parse({
    from_version: p.from_version,
    to_version: p.to_version,
    channel: p.channel,
    sha256: "",
    request_source: p.request_source,
  });
  return auditAwait(
    {
      ...SYSTEM_ACTOR,
      action: AuditAction.ENGINE_UPDATE_INITIATED,
      resource_type: "engine",
      resource_id: null,
      result: "success",
      reason: p.reason ?? "self-update binary swap",
      metadata,
    },
    p.executor,
  );
}

export interface RecordEngineUpdateCompletedParams extends EngineUpdateBase {
  sha256: string;
  reason?: string;
}

export async function recordEngineUpdateCompleted(
  p: RecordEngineUpdateCompletedParams,
): Promise<RecordedEntry> {
  const metadata = EngineUpdateMetadataSchema.parse({
    from_version: p.from_version,
    to_version: p.to_version,
    channel: p.channel,
    sha256: p.sha256,
    request_source: p.request_source,
  });
  return auditAwait(
    {
      ...SYSTEM_ACTOR,
      action: AuditAction.ENGINE_UPDATE_COMPLETED,
      resource_type: "engine",
      resource_id: null,
      result: "success",
      reason: p.reason ?? "self-update binary swap",
      metadata,
    },
    p.executor,
  );
}

export interface RecordEngineUpdateFailedParams extends EngineUpdateBase {
  reason: string;
  sha256?: string;
}

export async function recordEngineUpdateFailed(
  p: RecordEngineUpdateFailedParams,
): Promise<RecordedEntry> {
  const metadata = EngineUpdateMetadataSchema.parse({
    from_version: p.from_version,
    to_version: p.to_version,
    channel: p.channel,
    sha256: p.sha256 ?? "",
    request_source: p.request_source,
    reason: p.reason,
  });
  return auditAwait(
    {
      ...SYSTEM_ACTOR,
      action: AuditAction.ENGINE_UPDATE_FAILED,
      resource_type: "engine",
      resource_id: null,
      result: "error",
      reason: p.reason,
      metadata,
    },
    p.executor,
  );
}

export interface RecordEngineUpdateRolledBackParams
  extends Omit<EngineUpdateBase, "request_source"> {
  sha256: string;
  reason?: string;
}

export async function recordEngineUpdateRolledBack(
  p: RecordEngineUpdateRolledBackParams,
): Promise<RecordedEntry> {
  const metadata = EngineUpdateMetadataSchema.parse({
    from_version: p.from_version,
    to_version: p.to_version,
    channel: p.channel,
    sha256: p.sha256,
    request_source: "rollback",
  });
  return auditAwait(
    {
      ...SYSTEM_ACTOR,
      action: AuditAction.ENGINE_UPDATE_ROLLED_BACK,
      resource_type: "engine",
      resource_id: null,
      result: "success",
      reason: p.reason ?? "rollback to retained binary",
      metadata,
    },
    p.executor,
  );
}
