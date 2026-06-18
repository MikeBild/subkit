// Engine self-update audit recorders.
//
// `engine --self-update` and `engine --rollback` mutate the running
// binary from a host shell with no HTTP context. The audit row is the
// only paper trail that says a privileged change happened. Tenant is
// always `SYSTEM_TENANT_ID` (the binary is process-wide, not
// tenant-scoped); actor_type is `"system"` because the change is
// process-level — there is no `system_accounts` row backing it, so
// `actor_id` is null. The `request_source` field in the metadata is
// the canonical way an operator distinguishes self-update from rollback.
//
// Metadata shape is locked by `EngineUpdateMetadataSchema` in
// `../types.ts` so a forensic SELECT can rely on `from_version`,
// `to_version`, `channel`, `sha256`, and `request_source` always being
// present (sha256 may be empty for INITIATED / pre-download FAILED, see
// the schema for the precise semantics).
//
// **DO NOT WIDEN** the recorder param shape with `tenant_id` /
// `actor_id` overrides. The audit contract declares any HTTP- or
// MCP-driven self-update surface an anti-goal — host shell + signed
// binary is the only authorised path. Adding optional override fields
// here invites drift: a future contributor reads the seam, concludes
// "the override is here on purpose", and adds a `POST /v1/system/update`
// route that bypasses the operator-shell-only contract.

import { auditAwait } from "../audit.ts";
import { AuditAction, EngineUpdateMetadataSchema, SYSTEM_TENANT_ID } from "../types.ts";
import type { Executor, RecordedEntry } from "./types.ts";

/** Common shape for every engine.update.* recorder. Tenant + actor are
 *  fixed by the binary's host-only execution model; they are NOT
 *  parameters. See the file-level "DO NOT WIDEN" note. */
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
  /** Free-form reason captured for forensic context. Defaults to
   *  "self-update binary swap" when omitted. */
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
  /** SHA256 of the binary that was actually swapped in (post-verify). */
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

/** RolledBack omits `request_source` from the param surface — the row
 *  is always emitted under `request_source: "rollback"` because that is
 *  what the action name (ENGINE_UPDATE_ROLLED_BACK) means. Keeping the
 *  field as a parameter would be dead code and would invite a future
 *  contributor to pass `"self-update"` here, which the recorder would
 *  silently override. */
export interface RecordEngineUpdateRolledBackParams
  extends Omit<EngineUpdateBase, "request_source"> {
  /** SHA256 of the retained binary that was restored. */
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
