import { FILE_DIALOG_REFUSAL } from "@shared/device/computer.ts";
import { untrustedPayload } from "@shared/untrusted-content.ts";
import type { StepOutcome } from "../../../devices/core/command-state.ts";
import { NOTHING_CHANGED } from "../../../devices/core/local-confirmation.ts";
import { parseBrowserSnapshot, parseWindowSnapshot } from "./snapshot.ts";

export interface DeviceToolFailure {
  readonly ok: false;
  readonly error_code: string;
  readonly message: string;
  readonly data: Record<string, unknown>;
}

export type DeviceToolOutput =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | DeviceToolFailure;

type Bag = Record<string, unknown>;

function bag(value: unknown): Bag {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Bag) : {};
}

function pick(source: Bag, keys: readonly string[]): Bag {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
}

export function successData(tool: string, output: unknown, call_id: string): Bag {
  const out = bag(output);
  switch (tool) {
    case "browser_snapshot": {
      const page = parseBrowserSnapshot(output);
      return {
        snapshot_id: call_id,
        origin: page.origin,
        page: untrustedPayload("page", page.text),
      };
    }
    case "browser_extract":
      return {
        origin: bag(out.step).origin ?? null,
        page: untrustedPayload("page", out.text ?? ""),
      };
    case "browser_screenshot":
    case "computer_screenshot":
      return { shown_in_live_view: true, ...pick(out, ["width", "height", "redacted", "sha256"]) };
    case "computer_apps":
      return { windows: untrustedPayload("window", out.windows ?? []) };
    case "computer_snapshot": {
      const window = parseWindowSnapshot(output);
      return {
        snapshot_id: window?.snapshot_id ?? null,
        window_id: window?.window_id ?? null,
        app: window?.app ?? null,
        window: untrustedPayload("window", window?.tree ?? null),
      };
    }
    case "files_list":
      return {
        entries: untrustedPayload("listing", out.entries ?? []),
        ...pick(out, ["truncated", "omitted"]),
      };
    case "files_read":
      return { file: untrustedPayload("file", out.text ?? ""), ...pick(out, ["size", "sha256"]) };
    default:
      if (tool.startsWith("browser_")) return { done: true, origin: bag(out.step).origin ?? null };
      if (tool.startsWith("computer_")) return { done: true, ...pick(out, ["delivery"]) };
      return { done: true, ...pick(out, ["items", "replaced", "previous_in_trash", "created"]) };
  }
}

const CHANGED_UNKNOWN = new Set(["device_lost_during_write", "delivery_uncertain"]);

export const CHECK_FIRST =
  "The input may have reached the page or app. Read the page or app (snapshot or extract) before you repeat this step; never repeat it blindly.";

export function deviceToolOutput(
  tool: string,
  outcome: StepOutcome,
  call_id: string,
): DeviceToolOutput {
  if (outcome.status === "succeeded")
    return { ok: true, data: successData(tool, outcome.output, call_id) };
  const code = outcome.code ?? "device_failed";
  const message = outcome.message ?? "The device could not run this step.";
  return {
    ok: false,
    error_code: code,
    message,
    data: {
      status: outcome.status,
      ...(CHANGED_UNKNOWN.has(code) ? {} : { nothing_changed: NOTHING_CHANGED }),
      ...(code === "delivery_uncertain" ? { check_first: CHECK_FIRST } : {}),
      ...(code === "blocked_app" && message.includes(FILE_DIALOG_REFUSAL.en)
        ? { refusal: FILE_DIALOG_REFUSAL }
        : {}),
    },
  };
}

const STOP_MESSAGES: Readonly<Record<string, string>> = {
  no_snapshot: "Take a snapshot first: actions on refs need the snapshot taken right before them.",
  snapshot_used:
    "The page or window may have changed since the last snapshot. Take a new snapshot and use its refs.",
  other_snapshot: "This ref belongs to an older snapshot. Take a new snapshot and use its refs.",
  unknown_ref: "This ref is not in the latest snapshot. Take a new snapshot and use its refs.",
  stale: "The page changed since it was checked. Take a new snapshot and try again.",
  no_device: "No device of this person offers this capability right now.",
  choose_device: "Several devices can do this. Name one with device_id.",
  not_started_by_person:
    "Only the person of this device may start local steps on it, from a chat or a task of their own.",
  outside_device_boundary: "This is outside what the device allows.",
  other_job: "This step belongs to another request.",
  job_expired: "The request this step belonged to has ended.",
};

export function stoppedOutput(code: string, detail: string | null = null): DeviceToolFailure {
  const base = STOP_MESSAGES[code] ?? "SubKit did not run this step.";
  return {
    ok: false,
    error_code: code,
    message: `${base} ${NOTHING_CHANGED.en}`,
    data: { status: "not_run", ...(detail ? { detail } : {}), nothing_changed: NOTHING_CHANGED },
  };
}
