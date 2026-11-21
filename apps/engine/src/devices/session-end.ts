import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { conversationElicitations, deviceCommands } from "../db/schema/index.ts";
import { emitResourceChange } from "../pubsub/resource-changes.ts";

export type DeviceSessionOwner =
  | { readonly conversation_id: string }
  | { readonly task_run_id: string };

async function stillAsking(exec: Executor, tenant_id: string, conversation_id: string) {
  const [pending] = await exec
    .select({ id: conversationElicitations.id })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, tenant_id),
        eq(conversationElicitations.conversation_id, conversation_id),
        eq(conversationElicitations.status, "pending"),
      ),
    )
    .limit(1);
  return pending !== undefined;
}

export async function endDeviceSessions(
  exec: Executor,
  tenant_id: string,
  owner: DeviceSessionOwner,
): Promise<number> {
  const chat = "conversation_id" in owner;
  if (chat && (await stillAsking(exec, tenant_id, owner.conversation_id))) return 0;
  const devices = await exec
    .selectDistinct({ device_id: deviceCommands.device_id })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.tenant_id, tenant_id),
        chat
          ? eq(deviceCommands.conversation_id, owner.conversation_id)
          : eq(deviceCommands.task_run_id, owner.task_run_id),
      ),
    );
  for (const { device_id } of devices)
    await emitResourceChange(exec, {
      tenant_id,
      type: "device.session_ended",
      ids: { device_id, ...owner },
    });
  return devices.length;
}
