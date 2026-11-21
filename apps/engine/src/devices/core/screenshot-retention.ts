import type { DeviceCommandKind } from "@shared/device/protocol.ts";

export const SCREENSHOT_RETENTION_MS = 30 * 24 * 60 * 60_000;

export const SCREENSHOT_KINDS = [
  "browser.screenshot",
  "computer.screenshot",
] as const satisfies readonly DeviceCommandKind[];

export function screenshotExpiryAt(kind: string, state: string, stored_at_ms: number): Date | null {
  if (state !== "done" || !(SCREENSHOT_KINDS as readonly string[]).includes(kind)) return null;
  return new Date(stored_at_ms + SCREENSHOT_RETENTION_MS);
}
