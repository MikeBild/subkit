import {
  type NotificationPauseBody,
  pauseRequestForMinutes,
  pauseState,
} from "../../../../packages/shared/src/notification-pause.ts";
import { currentMute, type Mute, type QuietHours } from "./quiet-hours.ts";

export const PAUSE_PATH = "/v1/identity/me/notification-pause";
export const TRAY_PAUSE_MINUTES = 60;
export const HELD_MEMORY_MS = 90_000;

export type PauseSupport = "unknown" | "server" | "local";

export function pauseSupportOf(status: number): PauseSupport | null {
  if (status >= 200 && status < 300) return "server";
  if (status === 404 || status === 405) return "local";
  return null;
}

export function parsePause(json: unknown): NotificationPauseBody | null {
  if (!json || typeof json !== "object") return null;
  const { paused, mode, paused_at, until } = json as Record<string, unknown>;
  if (typeof paused !== "boolean") return null;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    paused,
    mode: mode === "until" || mode === "until_resumed" ? mode : null,
    paused_at: text(paused_at),
    until: text(until),
  };
}

export interface Held {
  by: "pause" | "schedule";
  until: number | null;
  at: number;
}

export function heldHint(data: string, now: number): Held | null {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const { held_by, held_until } = payload as Record<string, unknown>;
  if (held_by !== "pause" && held_by !== "schedule") return null;
  const until = typeof held_until === "string" ? Date.parse(held_until) : Number.NaN;
  return { by: held_by, until: Number.isFinite(until) ? until : null, at: now };
}

export function freshHeld(held: Held | null, now: number): Held | null {
  return held && now - held.at <= HELD_MEMORY_MS ? held : null;
}

export interface PauseInputs {
  support: PauseSupport;
  server: NotificationPauseBody | null;
  held: Held | null;
  quietHours: QuietHours;
  localPauseUntil: number | null;
  now: number;
}

export function trayMute(input: PauseInputs): Mute | null {
  const now = new Date(input.now);
  if (input.support !== "server")
    return currentMute({ quietHours: input.quietHours, pauseUntil: input.localPauseUntil }, now);
  const pause = pauseState(input.server, input.now);
  if (pause.kind === "until") return { reason: "paused", until: new Date(pause.until) };
  if (pause.kind === "until_resumed") return { reason: "paused", until: null };
  const held = freshHeld(input.held, input.now);
  if (held?.by === "schedule")
    return { reason: "quiet-hours", until: held.until === null ? null : new Date(held.until) };
  return currentMute({ quietHours: input.quietHours, pauseUntil: null }, now);
}

export type PauseRequest =
  | { method: "PUT"; body: { mode: "for"; minutes: number } }
  | { method: "DELETE" };

export function pauseToggle(paused: boolean): PauseRequest {
  return paused
    ? { method: "DELETE" }
    : { method: "PUT", body: pauseRequestForMinutes(TRAY_PAUSE_MINUTES) };
}
