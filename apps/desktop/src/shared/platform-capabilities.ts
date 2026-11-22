import type { DeviceCapability } from "@shared/device/protocol.ts";

export type DesktopPlatform = "darwin-arm64" | "win32-x64";

export const DESKTOP_PLATFORMS: readonly DesktopPlatform[] = ["darwin-arm64", "win32-x64"];

export type LocalFeature = "localWorkspace" | "files" | "browser" | "computer";

export const LOCAL_FEATURES: readonly LocalFeature[] = [
  "localWorkspace",
  "files",
  "browser",
  "computer",
];

export interface PlatformCapabilities {
  readonly platform: DesktopPlatform | null;
  readonly features: readonly LocalFeature[];
  readonly macOnly: readonly LocalFeature[];
  readonly permissions: boolean;
}

const FEATURES: Record<DesktopPlatform, readonly LocalFeature[]> = {
  "darwin-arm64": LOCAL_FEATURES,
  "win32-x64": [],
};

export function desktopPlatform(platform: string, arch: string): DesktopPlatform | null {
  const name = `${platform}-${arch}`;
  return (DESKTOP_PLATFORMS as readonly string[]).includes(name) ? (name as DesktopPlatform) : null;
}

export function platformCapabilities(platform: string, arch: string): PlatformCapabilities {
  const desktop = desktopPlatform(platform, arch);
  const features = desktop ? FEATURES[desktop] : [];
  return {
    platform: desktop,
    features,
    macOnly: LOCAL_FEATURES.filter((feature) => !features.includes(feature)),
    permissions: desktop === "darwin-arm64",
  };
}

export function supports(capabilities: PlatformCapabilities, feature: LocalFeature): boolean {
  return capabilities.features.includes(feature);
}

export function offeredDeviceCapabilities(
  capabilities: PlatformCapabilities,
  wanted: readonly DeviceCapability[],
): DeviceCapability[] {
  return wanted.filter((capability) => supports(capabilities, capability));
}

export interface LocalBundle {
  readonly engine: string;
  readonly postgres: string;
}

const BUNDLES: Partial<Record<DesktopPlatform, LocalBundle>> = {
  "darwin-arm64": { engine: "mac/arm64/engine", postgres: "darwin-arm64" },
};

export function localBundle(capabilities: PlatformCapabilities): LocalBundle | null {
  if (!capabilities.platform || !supports(capabilities, "localWorkspace")) return null;
  return BUNDLES[capabilities.platform] ?? null;
}
