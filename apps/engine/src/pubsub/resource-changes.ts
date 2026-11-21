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
  "knowledge_source.changed",
  "file.changed",
  "identity.changed",
  "rbac.changed",
  "api_key.changed",
  "settings.changed",
  "task.changed",
  "task.grant_changed",
  "task_run.changed",
  "device.online",
  "device.offline",
  "device.command",
  "device.session_ended",
  "local.confirmation_requested",
  "execution.waiting_for_device",
] as const;

export type ResourceChangeType = (typeof RESOURCE_CHANGE_TYPES)[number];

export interface ResourceChangeIds {
  workflow_id?: string | null;
  workflow_version_id?: string | null;
  authority_id?: string | null;
  schedule_id?: string | null;
  hook_id?: string | null;
  connector_id?: string | null;
  knowledge_source_id?: string | null;
  task_id?: string | null;
  task_run_id?: string | null;
  task_grant_id?: string | null;
  execution_id?: string | null;
  device_id?: string | null;
  command_id?: string | null;
  confirmation_id?: string | null;
  conversation_id?: string | null;
}

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
