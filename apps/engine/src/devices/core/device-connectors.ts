import { DEVICE_CAPABILITIES, type DeviceCapability } from "@shared/device/protocol.ts";

export const DEVICE_CONNECTOR_DRIVERS = {
  files: "local_files",
  browser: "local_browser",
  computer: "local_computer",
} as const satisfies Record<DeviceCapability, string>;

export const DEVICE_CONNECTOR_LOCALES = ["de", "en"] as const;
export type DeviceConnectorLocale = (typeof DEVICE_CONNECTOR_LOCALES)[number];

export const DEVICE_CONNECTOR_LABELS: Readonly<
  Record<DeviceConnectorLocale, Readonly<Record<DeviceCapability, string>>>
> = {
  de: { files: "Dateien", browser: "Browser", computer: "Computer" },
  en: { files: "Files", browser: "Browser", computer: "Computer" },
};

function localeOf(value: unknown): DeviceConnectorLocale | null {
  if (typeof value !== "string") return null;
  const tag = value.split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    DEVICE_CONNECTOR_LOCALES.find((locale) => tag === locale || tag.startsWith(`${locale}-`)) ??
    null
  );
}

export function deviceConnectorLocale(preferences: readonly unknown[]): DeviceConnectorLocale {
  for (const preference of preferences) {
    const locale = localeOf(preference);
    if (locale) return locale;
  }
  return "en";
}

export const DEVICE_CONNECTOR_ENVIRONMENTS = ["dev", "prod"] as const;

export interface DeviceConnectorSpec {
  slug: string;
  name: string;
  driver: (typeof DEVICE_CONNECTOR_DRIVERS)[DeviceCapability];
  environment: (typeof DEVICE_CONNECTOR_ENVIRONMENTS)[number];
  config: { device_id: string };
}

export function deviceConnectorSlug(device_id: string, capability: DeviceCapability): string {
  return `device-${device_id}-${capability}`;
}

export function deviceConnectorSpecs(
  device: { id: string; label: string },
  capabilities: unknown,
  locale: DeviceConnectorLocale,
): DeviceConnectorSpec[] {
  const on = new Set<unknown>(Array.isArray(capabilities) ? capabilities : undefined);
  return DEVICE_CAPABILITIES.filter((capability) => on.has(capability)).flatMap((capability) =>
    DEVICE_CONNECTOR_ENVIRONMENTS.map((environment) => ({
      slug: deviceConnectorSlug(device.id, capability),
      name: `${device.label}: ${DEVICE_CONNECTOR_LABELS[locale][capability]}`,
      driver: DEVICE_CONNECTOR_DRIVERS[capability],
      environment,
      config: { device_id: device.id },
    })),
  );
}

export function missingDeviceConnectors(
  specs: readonly DeviceConnectorSpec[],
  existing: readonly { slug: string; environment: string }[],
): DeviceConnectorSpec[] {
  const known = new Set(existing.map((row) => `${row.slug}\u0000${row.environment}`));
  return specs.filter((spec) => !known.has(`${spec.slug}\u0000${spec.environment}`));
}
