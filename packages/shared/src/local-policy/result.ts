import type { DeviceRefusal } from "../device/protocol.ts";

export type PolicyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: DeviceRefusal };

export const ALLOW: PolicyResult = Object.freeze({ ok: true });

export function refuse(code: DeviceRefusal): PolicyResult {
  return { ok: false, code };
}
