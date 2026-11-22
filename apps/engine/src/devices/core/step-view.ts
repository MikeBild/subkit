import {
  capabilityOfKind,
  type DeviceCapability,
  type DeviceCommandKind,
  type DeviceResult,
} from "@shared/device/protocol.ts";
import type { DeviceCommandState } from "./command-state.ts";
import { SCREENSHOT_KINDS } from "./screenshot-retention.ts";
import { screenshotRef } from "./step-output.ts";

export const DEVICE_STEP_VIEW_STATES = [
  "queued",
  "running",
  "done",
  "refused",
  "confirmation_required",
  "failed",
  "stopped",
  "unclear",
] as const;
export type DeviceStepViewState = (typeof DEVICE_STEP_VIEW_STATES)[number];

const VIEW_STATES: Record<DeviceCommandState, DeviceStepViewState> = {
  pending: "queued",
  claimed: "running",
  done: "done",
  refused: "refused",
  confirmation_required: "confirmation_required",
  failed: "failed",
  stopped: "stopped",
  cancelled: "stopped",
  revoked: "stopped",
  lost: "failed",
  expired: "failed",
};

export function stepViewState(
  state: DeviceCommandState,
  effect: "read" | "write",
): DeviceStepViewState {
  return state === "lost" && effect === "write" ? "unclear" : VIEW_STATES[state];
}

const TARGET_FIELDS: Readonly<Record<DeviceCapability, readonly string[]>> = {
  files: ["path", "to_path", "folder_id"],
  browser: ["url"],
  computer: ["app_id"],
};

export const STEP_TARGET_MAX = 200;

export function stepTarget(kind: DeviceCommandKind, args: unknown): string {
  const values = Object(args) as Record<string, unknown>;
  for (const field of TARGET_FIELDS[capabilityOfKind(kind)]) {
    const value = values[field];
    if (typeof value === "string" && value.length > 0) return value.slice(0, STEP_TARGET_MAX);
  }
  return "";
}

function originOf(url: string): string | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
}

function approvedSite(args: unknown): string {
  const sites = (Object(args) as { boundary?: { sites?: { origin?: unknown }[] } }).boundary?.sites;
  const origin =
    sites?.length === 1
      ? sites.map((site) => site.origin).find((value) => typeof value === "string")
      : undefined;
  return origin === undefined ? "" : String(origin).slice(0, STEP_TARGET_MAX);
}

export function stepTargets(
  steps: readonly { readonly kind: DeviceCommandKind; readonly args: unknown }[],
): string[] {
  let page = "";
  return steps.map(({ kind, args }) => {
    const target = stepTarget(kind, args);
    if (capabilityOfKind(kind) !== "browser") return target;
    if (target !== "") {
      page = originOf(target) ?? page;
      return target;
    }
    return page || approvedSite(args);
  });
}

export function hasScreenshot(kind: string, state: DeviceCommandState, stored: boolean): boolean {
  return stored && state === "done" && (SCREENSHOT_KINDS as readonly string[]).includes(kind);
}

function pngBase64(output: unknown): string | null {
  const record = Object(output) as { image?: { base64?: unknown }; data?: unknown };
  const base64 = typeof record.image?.base64 === "string" ? record.image.base64 : record.data;
  return typeof base64 === "string" ? base64 : null;
}

export function screenshotPng(result: DeviceResult | null): Buffer | null {
  if (result?.status !== "done") return null;
  const base64 = pngBase64(result.output);
  if (base64 === null) return null;
  const png = Buffer.from(base64, "base64");
  return result.evidence.screenshot_ref === screenshotRef(png) ? png : null;
}
