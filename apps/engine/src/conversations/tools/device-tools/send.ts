import type { DeviceCommandKind } from "@shared/device/protocol.ts";
import type { Db } from "../../../db/index.ts";
import { sendDeviceCommand } from "../../../devices/index.ts";
import type { DeviceToolOutput } from "../../core/device-tools/result.ts";
import type { PendingDeviceCommand } from "../../device-tool-store.ts";
import type { ToolResult } from "../index.ts";

export function toolResult(output: DeviceToolOutput): ToolResult {
  return output.ok
    ? { ok: true, data: output.data }
    : { ok: false, error_code: output.error_code, message: output.message, data: output.data };
}

export async function send(
  db: Db,
  p: {
    readonly tenant_id: string;
    readonly tool_call_id: string;
    readonly pending: PendingDeviceCommand;
    readonly command_id: string;
    readonly kind: DeviceCommandKind;
    readonly args: Record<string, unknown>;
    readonly signal: AbortSignal;
  },
) {
  const { pending } = p;
  return await sendDeviceCommand(
    { db, signal: p.signal },
    {
      command_id: p.command_id,
      tenant_id: p.tenant_id,
      device_id: pending.device_id,
      execution_id: null,
      task_run_id: pending.owner.kind === "task_run" ? pending.owner.id : null,
      conversation_id: pending.owner.kind === "conversation" ? pending.owner.id : null,
      step_id: pending.tool,
      authority_id: null,
      manifest_digest: null,
      kind: p.kind,
      args: p.args,
      source: pending.source,
    },
  );
}
