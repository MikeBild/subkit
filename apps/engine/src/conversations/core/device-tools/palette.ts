import type { DeviceCapability } from "@shared/device/protocol.ts";
import { type LocalRunSource, taskRunSource } from "../../../devices/core/run-source.ts";
import type { PersonalBoundary } from "../../instruction-cover/job.ts";
import { DEVICE_TOOL_SPECS, type DeviceToolSpec } from "./catalog.ts";

export interface DeviceFacts {
  readonly device_id: string;
  readonly owner_user_id: string;
  readonly label: string;
  readonly online: boolean;
  readonly personal: readonly DeviceCapability[];
}

export interface TaskTurn {
  readonly owner_id: string;
  readonly started_by: string | null;
  readonly sealed: boolean;
}

export interface TurnFacts {
  readonly person_id: string | null;
  readonly interactive: boolean;
  readonly task: TaskTurn | null;
}

export interface EligibleDevice {
  readonly device_id: string;
  readonly label: string;
  readonly capabilities: readonly DeviceCapability[];
}

export function turnPerson(turn: TurnFacts): string | null {
  if (turn.task !== null) return turn.task.sealed ? null : turn.task.owner_id;
  return turn.interactive ? turn.person_id : null;
}

export function eligibleDevices(
  turn: TurnFacts,
  devices: readonly DeviceFacts[],
): EligibleDevice[] {
  const person = turnPerson(turn);
  return devices
    .filter(
      (device) => device.owner_user_id === person && device.online && device.personal.length > 0,
    )
    .map((device) => ({
      device_id: device.device_id,
      label: device.label,
      capabilities: [...new Set(device.personal)],
    }));
}

export function paletteTools(eligible: readonly EligibleDevice[]): DeviceToolSpec[] {
  const capabilities = new Set(eligible.flatMap((device) => device.capabilities));
  return DEVICE_TOOL_SPECS.filter((tool) => capabilities.has(tool.capability));
}

export type DevicePick =
  | { readonly ok: true; readonly device: EligibleDevice }
  | { readonly ok: false; readonly reason: "no_device" | "choose_device" };

export function pickDevice(
  eligible: readonly EligibleDevice[],
  capability: DeviceCapability,
  requested: string | null,
): DevicePick {
  const able = eligible.filter((device) => device.capabilities.includes(capability));
  if (requested !== null) {
    const named = able.find((device) => device.device_id === requested);
    return named ? { ok: true, device: named } : { ok: false, reason: "no_device" };
  }
  if (able.length === 0) return { ok: false, reason: "no_device" };
  if (able.length > 1) return { ok: false, reason: "choose_device" };
  return { ok: true, device: able[0] as EligibleDevice };
}

export function turnRunSource(turn: TurnFacts, device_owner: string): LocalRunSource {
  if (turn.task === null)
    return {
      trigger: "chat",
      started_by: turn.interactive ? turn.person_id : null,
      schedule_created_by: null,
      device_owner,
    };
  return taskRunSource(turn.task, device_owner);
}

export interface AllowanceFacts {
  readonly kind: "folder" | "site" | "app" | "keep_out";
  readonly display: string;
  readonly entered_by: "person" | "approval";
  readonly keep_out_target: "folder" | "app" | null;
}

export function personalBoundary(rows: readonly AllowanceFacts[]): PersonalBoundary {
  return {
    sites: {
      entered_by_person: rows
        .filter((row) => row.kind === "site" && row.entered_by === "person")
        .map((row) => row.display),
    },
    paths: {
      os: "darwin",
      data_dir: null,
      keep_out: rows
        .filter((row) => row.kind === "keep_out" && row.keep_out_target === "folder")
        .map((row) => row.display),
    },
  };
}
