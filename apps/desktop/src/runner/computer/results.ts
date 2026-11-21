import type { DeviceRefusal, DeviceResult } from "@shared/device/protocol.ts";

const DETAILS: Partial<Record<DeviceRefusal, string>> = {
  outside_allowance: "This app is not allowed on this device. Nothing was sent.",
  outside_boundary: "This app is outside the approved boundary. Nothing was sent.",
  credential_field: "SubKit never acts on password fields. Nothing was sent.",
  blocked_app: "This app is blocked for SubKit. Nothing was sent.",
  blocked_shortcut: "This shortcut is blocked for SubKit. Nothing was sent.",
  secure_focus: "A password field has focus. Nothing was sent.",
  stale: "The window changed since SubKit read it. Nothing was sent.",
  owner_active: "You are using the device right now. Nothing was sent.",
  stopped: "Stopped. Later steps won't run.",
  deadline_passed: "The command started too late and did not run.",
  permission_missing: "A permission is missing on this device. Nothing was sent.",
};

export function refused(code: DeviceRefusal): DeviceResult {
  return {
    status: "refused",
    code,
    detail: DETAILS[code] ?? "Refused on this device. Nothing was sent.",
  };
}

export function failed(code: string, detail: string): DeviceResult {
  return { status: "failed", code, detail };
}

export function refusedWith(code: DeviceRefusal, detail: string): DeviceResult {
  return { status: "refused", code, detail };
}
