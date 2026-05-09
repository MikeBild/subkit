// Engine self-update audit recorders. Issue #151 P0-2 / P0-4.
//
// `engine --self-update` and `engine --rollback` mutate the running
// binary from a host shell with no HTTP context. The audit row is the
// only paper trail that says a privileged change happened. Tenant is
// always `SYSTEM_TENANT_ID` (the binary is process-wide, not
// tenant-scoped); actor is the `engine-self-update` system_account.
//
// Metadata shape is locked by `EngineUpdateMetadataSchema` in
// `../types.ts` so a forensic SELECT can rely on `from_version`,
// `to_version`, `channel`, `sha256`, and `request_source` always being
// present (sha256 may be empty for INITIATED / pre-download FAILED, see
// the schema for the precise semantics).

import { auditAwait } from "../audit.ts";
import { AuditAction, EngineUpdateMetadataSchema, SYSTEM_TENANT_ID } from "../types.ts";
import type { RecordedEntry, RecorderBase } from "./types.ts";

const ENGINE_SELF_UPDATE_ACTOR_ID = "engine-self-update";

/** System-actor recorders — `tenant_id` and `actor_id` default to the
 *  engine self-update system_account so the call site doesn't have to
 *  thread them through. Override either explicitly if a future
 *  HTTP-driven surface needs to attribute the row to a real principal
 *  (anti-goal today, but the type surface should not preclude it). */
interface EngineUpdateBase extends Omit<RecorderBase, "tenant_id" | "actor_id"> {
  tenant_id?: string;
  actor_id?: string | null;
  from_version: string;
  to_version: string;
  channel: "stable" | "beta";
  request_source: "self-update" | "rollback";
}

interface FilledActor {
  tenant_id: string;
  actor_id: string | null;
  actor_type: "user" | "system_account" | "system";
}

function fillSystemActor(p: EngineUpdateBase): FilledActor {
  return {
    tenant_id: p.tenant_id ?? SYSTEM_TENANT_ID,
    actor_id: p.actor_id ?? ENGINE_SELF_UPDATE_ACTOR_ID,
    actor_type: p.actor_type ?? "system_account",
  };
}

export interface RecordEngineUpdateInitiatedParams extends EngineUpdateBase {
  /** Free-form reason captured for forensic context. Defaults to
   *  "self-update binary swap" when omitted. */
  reason?: string;
}

export async function recordEngineUpdateInitiated(
  p: RecordEngineUpdateInitiatedParams,
): Promise<RecordedEntry> {
  const filled = fillSystemActor(p);
  const metadata = EngineUpdateMetadataSchema.parse({
    from_version: p.from_version,
    to_version: p.to_version,
    channel: p.channel,
    sha256: "",
    actor: "cli",
    request_source: p.request_source,
  });
  return auditAwait(
    {
      tenant_id: filled.tenant_id,
      actor_type: filled.actor_type,
      actor_id: filled.actor_id,
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
  /** SHA256 of the binary that was actually swapped in (post-verify). */
  sha256: string;
  reason?: string;
}

export async function recordEngineUpdateCompleted(
  p: RecordEngineUpdateCompletedParams,
): Promise<RecordedEntry> {
  const filled = fillSystemActor(p);
  const metadata = EngineUpdateMetadataSchema.parse({
    from_version: p.from_version,
    to_version: p.to_version,
    channel: p.channel,
    sha256: p.sha256,
    actor: "cli",
    request_source: p.request_source,
  });
  return auditAwait(
    {
      tenant_id: filled.tenant_id,
      actor_type: filled.actor_type,
      actor_id: filled.actor_id,
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
  /** Why the swap failed. Free-form; surfaced verbatim so operators can
   *  search by error message. */
  reason: string;
  /** SHA256 of the binary that failed to install. Empty when failure
   *  happened before download. */
  sha256?: string;
}

export async function recordEngineUpdateFailed(
  p: RecordEngineUpdateFailedParams,
): Promise<RecordedEntry> {
  const filled = fillSystemActor(p);
  const metadata = EngineUpdateMetadataSchema.parse({
    from_version: p.from_version,
    to_version: p.to_version,
    channel: p.channel,
    sha256: p.sha256 ?? "",
    actor: "cli",
    request_source: p.request_source,
    reason: p.reason,
  });
  return auditAwait(
    {
      tenant_id: filled.tenant_id,
      actor_type: filled.actor_type,
      actor_id: filled.actor_id,
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

export interface RecordEngineUpdateRolledBackParams extends EngineUpdateBase {
  /** SHA256 of the retained binary that was restored. */
  sha256: string;
  reason?: string;
}

export async function recordEngineUpdateRolledBack(
  p: RecordEngineUpdateRolledBackParams,
): Promise<RecordedEntry> {
  const filled = fillSystemActor(p);
  const metadata = EngineUpdateMetadataSchema.parse({
    from_version: p.from_version,
    to_version: p.to_version,
    channel: p.channel,
    sha256: p.sha256,
    actor: "cli",
    request_source: "rollback",
  });
  return auditAwait(
    {
      tenant_id: filled.tenant_id,
      actor_type: filled.actor_type,
      actor_id: filled.actor_id,
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
