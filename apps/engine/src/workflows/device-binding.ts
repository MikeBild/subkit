import type { Executor } from "../db/client.ts";
import { registeredDeviceFor } from "../devices/registry.ts";
import { DEVICE_APPROVAL_REFUSALS, deviceApprovalRefusal } from "./core/device-approval.ts";
import { manifestDeviceIds, type WorkflowEffectManifest } from "./core/effect-manifest.ts";

export async function assertDeviceApproval(
  tx: Executor,
  proof: { tenant_id: string; installation_id: string | null },
  manifest: Pick<WorkflowEffectManifest, "effects">,
): Promise<void> {
  const devices = manifestDeviceIds(manifest);
  if (devices.length === 0) return;
  const device =
    devices.length === 1
      ? await registeredDeviceFor(tx, proof.tenant_id, devices[0] as string)
      : null;
  const refusal = deviceApprovalRefusal(devices, proof.installation_id, device);
  if (refusal) throw Object.assign(new Error(DEVICE_APPROVAL_REFUSALS[refusal]), { code: refusal });
}
