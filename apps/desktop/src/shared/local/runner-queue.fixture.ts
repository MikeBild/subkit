import { type DeviceCommand, DeviceCommandSchema } from "@shared/device/protocol.ts";

export const NOW = Date.parse("2026-11-21T10:00:00Z");

export function command(id: string, overrides: Partial<DeviceCommand> = {}): DeviceCommand {
  return DeviceCommandSchema.parse({
    command_id: id,
    tenant_id: "tenant-1",
    execution_id: "exec-1",
    task_run_id: null,
    conversation_id: null,
    step_id: "step-1",
    authority_id: null,
    manifest_digest: null,
    kind: "files.list",
    args: { folder_id: "f1", relative_path: "" },
    deadline_at: new Date(NOW + 60_000).toISOString(),
    generation: 0,
    confirmation: null,
    ...overrides,
  });
}
