import {
  capabilityOfKind,
  type DeviceCapability,
  type DeviceCommandKind,
} from "@shared/device/protocol.ts";

export const DEVICE_ONLINE_WINDOW_MS = 45_000;
export const WAIT_ATTENTION_AFTER_MS = 15 * 60_000;
export const WAIT_CAP_MS = 24 * 60 * 60_000;

export const COMMAND_DEADLINE_MS: Readonly<Record<DeviceCapability, number>> = {
  files: 60_000,
  browser: 5 * 60_000,
  computer: 5 * 60_000,
};

export const OFFLINE_POLICIES = ["wait", "fail"] as const;
export type OfflinePolicy = (typeof OFFLINE_POLICIES)[number];

export type ManifestEffect = "read" | "write" | "unknown" | "destructive";

export type DeviceUnavailableCode = "device_offline" | "device_offline_timeout" | "device_revoked";

export type AdmissionVerdict =
  | { kind: "dispatch" }
  | { kind: "wait"; cap_at_ms: number; attention_at_ms: number }
  | { kind: "fail"; code: DeviceUnavailableCode };

export interface AdmissionFacts {
  revoked: boolean;
  online: boolean;
  policy: OfflinePolicy;
  waiting_since_ms: number;
  authority_valid_until_ms: number | null;
}

const READ_KINDS: ReadonlySet<DeviceCommandKind> = new Set([
  "files.list",
  "files.read_text",
  "browser.wait",
  "browser.extract",
  "browser.snapshot",
  "browser.screenshot",
  "computer.apps",
  "computer.snapshot",
  "computer.find",
  "computer.screenshot",
]);

export function waitCapAt(
  waiting_since_ms: number,
  authority_valid_until_ms: number | null,
): number {
  const cap = waiting_since_ms + WAIT_CAP_MS;
  return authority_valid_until_ms === null ? cap : Math.min(cap, authority_valid_until_ms);
}

export function attentionDueAt(waiting_since_ms: number): number {
  return waiting_since_ms + WAIT_ATTENTION_AFTER_MS;
}

export function admissionVerdict(facts: AdmissionFacts, now_ms: number): AdmissionVerdict {
  if (facts.revoked) return { kind: "fail", code: "device_revoked" };
  if (facts.online) return { kind: "dispatch" };
  if (facts.policy === "fail") return { kind: "fail", code: "device_offline" };
  const cap_at_ms = waitCapAt(facts.waiting_since_ms, facts.authority_valid_until_ms);
  if (now_ms >= cap_at_ms) return { kind: "fail", code: "device_offline_timeout" };
  return { kind: "wait", cap_at_ms, attention_at_ms: attentionDueAt(facts.waiting_since_ms) };
}

export function deviceRetryLimit(effects: readonly ManifestEffect[]): 0 | 1 {
  return effects.length > 0 && effects.every((effect) => effect === "read") ? 1 : 0;
}

export function commandEffect(kind: DeviceCommandKind): "read" | "write" {
  return READ_KINDS.has(kind) ? "read" : "write";
}

export function commandDeadlineAt(kind: DeviceCommandKind, now_ms: number): number {
  return now_ms + COMMAND_DEADLINE_MS[capabilityOfKind(kind)];
}

export function unavailableMessage(code: DeviceUnavailableCode, device_label: string): string {
  if (code === "device_revoked")
    return `“${device_label}” is no longer connected to this workspace. Nothing ran on it. Connect the device again in SubKit Desktop, then start the run again.`;
  if (code === "device_offline")
    return `“${device_label}” is offline and this workflow does not wait. Nothing ran on it. Open SubKit on “${device_label}”, then start the run again.`;
  return `“${device_label}” stayed offline for as long as this run may wait. Nothing ran on it. Open SubKit on “${device_label}”, then start the run again.`;
}
