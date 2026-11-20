import type { TranslationKey } from "@/lib/i18n";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export interface DeviceEntry {
  id: string;
  kind: "browser" | "desktop";
  device_label: string | null;
  created_at: string;
  last_used_at: string | null;
  current: boolean;
}

export interface DeviceRow {
  id: string;
  kind: "browser" | "desktop";
  name: string;
  created_at: string;
  last_used_at: string | null;
  current: boolean;
}

export function deviceName(entry: Pick<DeviceEntry, "kind" | "device_label">, t: Translate) {
  if (entry.kind === "browser") return t("settings.devices.webApp");
  return entry.device_label?.trim() || t("settings.devices.desktopUnnamed");
}

export function deviceRows(entries: readonly DeviceEntry[], t: Translate): DeviceRow[] {
  return entries
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      name: deviceName(entry, t),
      created_at: entry.created_at,
      last_used_at: entry.last_used_at,
      current: entry.current,
    }))
    .sort(
      (left, right) =>
        Number(right.current) - Number(left.current) ||
        left.created_at.localeCompare(right.created_at) ||
        left.id.localeCompare(right.id),
    );
}

export interface DeviceRevocation {
  verb: TranslationKey;
  consequence: TranslationKey;
}

export function deviceRevocation(row: Pick<DeviceRow, "kind" | "current">): DeviceRevocation {
  if (row.current)
    return {
      verb: "settings.devices.signOut",
      consequence: "settings.devices.consequence.current",
    };
  return {
    verb: "settings.devices.revoke",
    consequence:
      row.kind === "desktop"
        ? "settings.devices.consequence.desktop"
        : "settings.devices.consequence.webApp",
  };
}

export function canRevokeDevice(
  row: Pick<DeviceRow, "current">,
  askingFromDevice: boolean,
): boolean {
  return !askingFromDevice || row.current;
}
