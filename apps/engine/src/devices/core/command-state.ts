import type { DeviceResult, DeviceResultStatus } from "@shared/device/protocol.ts";
import { commandGenerationCurrent } from "./generation.ts";

export const COMMAND_LOST_AFTER_MS = 45_000;
export const READ_COMMAND_ATTEMPTS = 2;

export const DEVICE_COMMAND_STATES = [
  "pending",
  "claimed",
  "done",
  "refused",
  "confirmation_required",
  "failed",
  "stopped",
  "cancelled",
  "lost",
  "expired",
  "revoked",
] as const;
export type DeviceCommandState = (typeof DEVICE_COMMAND_STATES)[number];

export const OPEN_COMMAND_STATES = ["pending", "claimed"] as const;
export type ClosureState = "stopped" | "cancelled" | "lost" | "expired" | "revoked";

export function isOpenCommand(state: DeviceCommandState): boolean {
  return state === "pending" || state === "claimed";
}

export interface ClaimFacts {
  state: DeviceCommandState;
  deadline_at_ms: number;
  generation: number;
}

export type ClaimVerdict =
  | { ok: true }
  | { ok: false; reason: "already_claimed" | "closed" }
  | { ok: false; reason: "stopped"; close: "stopped" }
  | { ok: false; reason: "deadline_passed"; close: "expired" };

export function claimVerdict(
  command: ClaimFacts,
  now_ms: number,
  stop_generation: number,
): ClaimVerdict {
  if (command.state === "claimed") return { ok: false, reason: "already_claimed" };
  if (command.state !== "pending") return { ok: false, reason: "closed" };
  if (!commandGenerationCurrent(stop_generation, command.generation))
    return { ok: false, reason: "stopped", close: "stopped" };
  if (now_ms >= command.deadline_at_ms)
    return { ok: false, reason: "deadline_passed", close: "expired" };
  return { ok: true };
}

export type ResultVerdict = { store: true; state: DeviceResultStatus } | { store: false };

export function resultVerdict(state: DeviceCommandState, result: DeviceResult): ResultVerdict {
  return isOpenCommand(state) ? { store: true, state: result.status } : { store: false };
}

export function stopCloses(
  command: Pick<ClaimFacts, "state" | "generation">,
  stop_generation: number,
): boolean {
  return (
    isOpenCommand(command.state) && !commandGenerationCurrent(stop_generation, command.generation)
  );
}

export interface LivenessFacts {
  state: DeviceCommandState;
  deadline_at_ms: number;
  claimed_at_ms: number | null;
  last_progress_at_ms: number | null;
  last_heartbeat_at_ms: number | null;
}

export type LivenessVerdict =
  | { kind: "wait"; recheck_at_ms: number }
  | { kind: "lost" }
  | { kind: "expired" }
  | { kind: "closed" };

export function livenessVerdict(command: LivenessFacts, now_ms: number): LivenessVerdict {
  if (command.state === "pending")
    return now_ms >= command.deadline_at_ms
      ? { kind: "expired" }
      : { kind: "wait", recheck_at_ms: command.deadline_at_ms };
  if (command.state !== "claimed") return { kind: "closed" };
  const alive = Math.max(
    command.claimed_at_ms ?? 0,
    command.last_progress_at_ms ?? 0,
    command.last_heartbeat_at_ms ?? 0,
  );
  const limit = Math.min(
    alive + COMMAND_LOST_AFTER_MS,
    command.deadline_at_ms + COMMAND_LOST_AFTER_MS,
  );
  return now_ms >= limit ? { kind: "lost" } : { kind: "wait", recheck_at_ms: limit };
}

export function retriesAfterLoss(effect: "read" | "write", attempt: number): boolean {
  return effect === "read" && attempt < READ_COMMAND_ATTEMPTS;
}

export interface StepOutcome {
  status: "succeeded" | "failed" | "aborted";
  output?: unknown;
  code?: string;
  message?: string;
}

export function resultOutcome(result: DeviceResult): StepOutcome {
  switch (result.status) {
    case "done":
      return { status: "succeeded", output: result.output };
    case "refused":
    case "failed":
      return { status: "failed", code: result.code, message: result.detail };
    case "confirmation_required":
      return {
        status: "failed",
        code: "confirmation_required",
        message: "This step waits for a person to confirm it. Nothing was sent or changed.",
      };
    case "stopped":
      return {
        status: "aborted",
        code: "device_stopped",
        message: "Stopped on the device. Later steps won't run.",
      };
  }
}

export function closureOutcome(closure: ClosureState, effect: "read" | "write"): StepOutcome {
  switch (closure) {
    case "stopped":
      return {
        status: "aborted",
        code: "device_stopped",
        message: "Stopped on the device. Later steps won't run.",
      };
    case "cancelled":
      return { status: "aborted", code: "cancelled", message: "The run was stopped." };
    case "expired":
      return {
        status: "failed",
        code: "deadline_passed",
        message: "The device did not start this step in time. Nothing was run.",
      };
    case "revoked":
      return {
        status: "failed",
        code: "device_revoked",
        message: "The device was disconnected from this workspace. Nothing more runs on it.",
      };
    case "lost":
      return effect === "write"
        ? {
            status: "failed",
            code: "device_lost_during_write",
            message:
              "The device stopped answering during a change. It is not repeated automatically; check on the device what was done before you run it again.",
          }
        : {
            status: "failed",
            code: "device_lost",
            message: "The device stopped answering. Nothing was changed.",
          };
  }
}
