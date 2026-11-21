import type { components } from "@cli-core/engine-api/openapi";
import type { TranslationKey } from "@/lib/i18n";

type Preview = components["schemas"]["WorkflowAuthorityPreview"];
type Device = components["schemas"]["DeviceListItem"];

export const DEVICE_APPROVAL_REFUSALS = [
  "device_approval_elsewhere",
  "device_unavailable",
  "device_binding_multiple",
] as const;
export type DeviceApprovalRefusal = (typeof DEVICE_APPROVAL_REFUSALS)[number];

export function deviceRefusal(code: unknown): DeviceApprovalRefusal | null {
  return DEVICE_APPROVAL_REFUSALS.find((refusal) => refusal === code) ?? null;
}

export function deviceRefusalKey(refusal: DeviceApprovalRefusal): TranslationKey {
  return `authority.device.refusal.${refusal}`;
}

export function approvalDeviceIds(preview: Preview | null | undefined): string[] {
  const ids = (preview?.manifest.effects ?? []).flatMap((effect) =>
    effect.device ? [effect.device.device_id] : [],
  );
  return [...new Set(ids)].sort();
}

export interface ApprovalDevice {
  deviceId: string;
  label: string | null;
  online: boolean;
  waiting: boolean;
  elsewhere: boolean;
}

export function approvalDevice(
  preview: Preview | null | undefined,
  devices: readonly Device[] | undefined,
): ApprovalDevice | null {
  const ids = approvalDeviceIds(preview);
  const [deviceId] = ids;
  if (ids.length !== 1 || !deviceId) return null;
  const known = devices?.find((device) => device.id === deviceId);
  const online = known?.online ?? false;
  const elsewhere = devices !== undefined && !known?.is_this_installation;
  return {
    deviceId,
    label: known?.device_label.trim() || null,
    online,
    waiting: devices !== undefined && !online && !elsewhere,
    elsewhere,
  };
}

export function deviceGrantBlocked(device: ApprovalDevice | null, mayRun: boolean): boolean {
  return device !== null && (device.elsewhere || !mayRun);
}
