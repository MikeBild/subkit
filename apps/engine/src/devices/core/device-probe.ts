import type { DeviceCapability } from "@shared/device/protocol.ts";

export interface DeviceProbeFacts {
  online: boolean;
  capabilities: Record<string, unknown>;
}

export type DeviceProbeVerdict =
  | { ok: true; detail: string }
  | { ok: false; error_code: "remote_resource_not_found" | "remote_api_disabled"; detail: string };

export function deviceProbeVerdict(
  device: DeviceProbeFacts | null,
  capability: DeviceCapability,
): DeviceProbeVerdict {
  if (!device)
    return {
      ok: false,
      error_code: "remote_resource_not_found",
      detail: "This device is no longer connected to this workspace. Nothing was sent.",
    };
  if (!device.online)
    return {
      ok: false,
      error_code: "remote_api_disabled",
      detail: "The device is offline. Open SubKit on it; nothing was sent.",
    };
  const offered = device.capabilities.capabilities;
  if (!Array.isArray(offered) || !offered.includes(capability))
    return {
      ok: false,
      error_code: "remote_api_disabled",
      detail: `The device has ${capability} turned off in Settings › Local capabilities. Nothing was sent.`,
    };
  return { ok: true, detail: `The device is online and offers ${capability}.` };
}
