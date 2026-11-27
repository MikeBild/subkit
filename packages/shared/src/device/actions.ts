import type { DeviceCommandKind } from "./protocol.ts";

export const DEVICE_ACTIONS = [
  "open",
  "fill",
  "press",
  "read",
  "wait",
  "download",
  "screenshot",
  "signin",
  "focus",
  "files",
] as const;
export type DeviceAction = (typeof DEVICE_ACTIONS)[number];

const ACTIONS: Record<DeviceCommandKind, DeviceAction> = {
  "files.list": "files",
  "files.read_text": "files",
  "files.import": "files",
  "files.write": "files",
  "files.mkdir": "files",
  "files.move": "files",
  "files.trash": "files",
  "browser.open": "open",
  "browser.wait": "wait",
  "browser.extract": "read",
  "browser.fill": "fill",
  "browser.press": "press",
  "browser.download": "download",
  "browser.pdf": "download",
  "browser.snapshot": "read",
  "browser.screenshot": "screenshot",
  "browser.handover": "signin",
  "browser.sign_in": "signin",
  "browser.pay": "fill",
  "computer.apps": "read",
  "computer.open": "open",
  "computer.snapshot": "read",
  "computer.find": "read",
  "computer.screenshot": "screenshot",
  "computer.press": "press",
  "computer.focus": "focus",
  "computer.select": "fill",
  "computer.set_value": "fill",
  "computer.type": "fill",
  "computer.key": "press",
  "computer.scroll": "read",
  "computer.handover": "signin",
};

export function deviceAction(kind: DeviceCommandKind): DeviceAction {
  return ACTIONS[kind];
}
