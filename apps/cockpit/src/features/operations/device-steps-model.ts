import { type DeviceAction, deviceAction } from "@shared/device/actions.ts";
import {
  type DeviceCommandKind,
  DeviceCommandKindSchema,
  type DeviceResultStatus,
} from "@shared/device/protocol.ts";
import type { Tone } from "@ui/atoms/pill";

export type DeviceStepState = "queued" | "running" | "unclear" | DeviceResultStatus;

export interface DeviceStepRecord {
  command_id: string;
  kind: DeviceCommandKind;
  target: string;
  state: DeviceStepState;
  screenshot: boolean;
}

export interface DeviceStepItem {
  command_id: string;
  kind: string;
  target: string | null;
  state: DeviceStepState;
  screenshot: boolean;
}

export interface DeviceStepRow {
  id: string;
  action: DeviceAction;
  target: string;
  state: DeviceStepState;
  tone: Tone;
  thumbnail: string | null;
}

const TONES: Record<DeviceStepState, Tone> = {
  queued: "neutral",
  running: "info",
  done: "success",
  confirmation_required: "warning",
  refused: "danger",
  failed: "danger",
  stopped: "neutral",
  unclear: "warning",
};

export function deviceStepRecords(items: readonly DeviceStepItem[]): DeviceStepRecord[] {
  return items.flatMap((item) => {
    const kind = DeviceCommandKindSchema.safeParse(item.kind);
    return kind.success
      ? [
          {
            command_id: item.command_id,
            kind: kind.data,
            target: item.target ?? "",
            state: item.state,
            screenshot: item.screenshot,
          },
        ]
      : [];
  });
}

export function stepScreenshotPath(executionId: string, commandId: string): string {
  return `/v1/executions/${encodeURIComponent(executionId)}/device-steps/${encodeURIComponent(commandId)}/screenshot`;
}

export function deviceStepRows(
  records: readonly DeviceStepRecord[],
  executionId: string,
): DeviceStepRow[] {
  return records.map((record) => ({
    id: record.command_id,
    action: deviceAction(record.kind),
    target: record.target,
    state: record.state,
    tone: TONES[record.state],
    thumbnail: record.screenshot ? stepScreenshotPath(executionId, record.command_id) : null,
  }));
}

export function stepsStillMoving(records: readonly DeviceStepRecord[]): boolean {
  return records.some((record) => record.state === "queued" || record.state === "running");
}

export const NO_DEVICE_STEPS: readonly DeviceStepRecord[] = [];
