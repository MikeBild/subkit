export const DEVICE_APPROVAL_REFUSALS = {
  device_binding_multiple: "a workflow may name at most one device; split it per device",
  device_unavailable: "the device this workflow names is no longer signed in to this workspace",
  device_approval_elsewhere: "open SubKit on the device this workflow names to approve it there",
} as const;
export type DeviceApprovalRefusal = keyof typeof DEVICE_APPROVAL_REFUSALS;

export interface RegisteredDevice {
  installation_id: string;
  revoked: boolean;
}

export function deviceApprovalRefusal(
  deviceIds: readonly string[],
  sessionInstallationId: string | null,
  device: RegisteredDevice | null,
): DeviceApprovalRefusal | null {
  if (deviceIds.length === 0) return null;
  if (deviceIds.length > 1) return "device_binding_multiple";
  if (!device || device.revoked) return "device_unavailable";
  if (device.installation_id !== sessionInstallationId) return "device_approval_elsewhere";
  return null;
}
