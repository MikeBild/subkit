import { DEVICE_CAPABILITIES, type DeviceCapability } from "@shared/device/protocol";
import type { DeviceListItem, DeviceScope } from "@/api/devices";
import type { PluralKey, TranslationKey } from "@/lib/i18n";

type Plural = (key: PluralKey, count: number) => string;

export interface LocalDeviceRow {
  id: string;
  name: string;
  online: boolean;
  own: boolean;
  here: boolean;
  capabilities: DeviceCapability[];
  counts: { folder: number; site: number; app: number };
  lastSeen: string | null;
}

export function deviceScope(permissions: readonly string[]): DeviceScope {
  return permissions.includes("device:revoke_any") ? "all" : "own";
}

export function capabilitiesOf(raw: Record<string, unknown>): DeviceCapability[] {
  const listed = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  return DEVICE_CAPABILITIES.filter((capability) => listed.includes(capability));
}

export function localDeviceRows(
  items: readonly DeviceListItem[],
  userId: string,
  unnamed: string,
): LocalDeviceRow[] {
  return items
    .map((item) => ({
      id: item.id,
      name: item.device_label.trim() || unnamed,
      online: item.online,
      own: item.owner_user_id === userId,
      here: item.is_this_installation,
      capabilities: capabilitiesOf(item.capabilities),
      counts: {
        folder: item.allowance_counts.folder,
        site: item.allowance_counts.site,
        app: item.allowance_counts.app,
      },
      lastSeen: item.last_heartbeat_at,
    }))
    .sort(
      (left, right) =>
        Number(right.here) - Number(left.here) ||
        Number(right.own) - Number(left.own) ||
        Number(right.online) - Number(left.online) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
}

export function countsLine(counts: LocalDeviceRow["counts"], tn: Plural): string {
  return [
    tn("settings.localDevices.folders", counts.folder),
    tn("settings.localDevices.sites", counts.site),
    tn("settings.localDevices.apps", counts.app),
  ].join(" · ");
}

export const CAPABILITY_LABEL: Record<DeviceCapability, TranslationKey> = {
  files: "settings.localDevices.capability.files",
  browser: "settings.localDevices.capability.browser",
  computer: "settings.localDevices.capability.computer",
};
