import type { Translate, TranslationKey } from "@/lib/i18n";

export interface DeviceConfirmation {
  device_id: string;
  capability: "files" | "browser" | "computer";
  target: string;
  deadline_at: string;
}

export interface KnownDevice {
  id: string;
  device_label: string;
}

export type DeviceApprovalRow = [label: string, value: string, testId: string];

const CAPABILITY_KEYS: Record<DeviceConfirmation["capability"], TranslationKey> = {
  files: "chat.device.capability.files",
  browser: "chat.device.capability.browser",
  computer: "chat.device.capability.computer",
};

export function deviceLabelOf(
  devices: readonly KnownDevice[] | undefined,
  deviceId: string,
): string | null {
  return devices?.find((device) => device.id === deviceId)?.device_label ?? null;
}

export function deviceApprovalRows(
  device: DeviceConfirmation,
  label: string | null,
  t: Translate,
  testId: string,
): DeviceApprovalRow[] {
  return [
    [t("chat.device.row.device"), label ?? t("chat.device.unknownDevice"), `${testId}-device`],
    [
      t("chat.device.row.capability"),
      t(CAPABILITY_KEYS[device.capability]),
      `${testId}-capability`,
    ],
    [t("chat.device.row.target"), device.target, `${testId}-target`],
  ];
}
