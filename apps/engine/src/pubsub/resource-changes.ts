// `resource.lifecycle` — state changes a live reader must hear about that
// no other channel carries: an execution authority granted or revoked, a
// schedule or inbound hook changed or held, a connector or its credentials
// changed.
//
// The channel is internal. The outbound fan-out (webhooks and notification
// rules) is wired to `execution.status` and `notification.emitted` only, so
// nothing here becomes public webhook contract; the one reader is the
// Cockpit's live stream (`GET /v1/cockpit/events/stream`), which refreshes
// what it shows when one of these arrives.
//
// The payload is ids only. What changed is read back through the REST
// surface under the reader's own permissions, never from the event.

import type { Executor } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";

export const RESOURCE_CHANGE_TYPES = [
  "workflow.authority_granted",
  "workflow.authority_revoked",
  "workflow.automation_changed",
  "connector.created",
  "connector.updated",
  "connector.deleted",
  "connector.credential_changed",
] as const;

export type ResourceChangeType = (typeof RESOURCE_CHANGE_TYPES)[number];

export interface ResourceChangeIds {
  workflow_id?: string | null;
  workflow_version_id?: string | null;
  authority_id?: string | null;
  schedule_id?: string | null;
  hook_id?: string | null;
  connector_id?: string | null;
}

/** A connector's stored credential was written or removed. */
export async function emitCredentialChange(
  tx: Executor,
  tenant_id: string,
  connector_id: string | null | undefined,
): Promise<void> {
  await emitResourceChange(tx, {
    tenant_id,
    type: "connector.credential_changed",
    ids: { connector_id: connector_id ?? null },
  });
}

/** Write one `resource.lifecycle` row inside the caller's transaction. */
export async function emitResourceChange(
  tx: Executor,
  input: { tenant_id: string; type: ResourceChangeType; ids: ResourceChangeIds },
): Promise<void> {
  const payload: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.ids)) {
    if (typeof value === "string" && value.length > 0) payload[key] = value;
  }
  await writeEvent(tx, {
    tenant_id: input.tenant_id,
    channel: "resource.lifecycle",
    type: input.type,
    payload,
  });
}
