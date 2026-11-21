import { parseClock, DEFAULT_QUIET_HOURS as SHARED_QUIET_HOURS } from "@shared/quiet-hours.ts";

export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: false, ...SHARED_QUIET_HOURS };

export function inQuietHours(quiet: QuietHours, now: Date): boolean {
  if (!quiet.enabled) return false;
  const start = parseClock(quiet.start);
  const end = parseClock(quiet.end);
  if (start === null || end === null || start === end) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

export type MuteReason = "paused" | "quiet-hours";

export function muteReason(
  settings: { quietHours: QuietHours; pauseUntil: number | null },
  now: Date,
): MuteReason | null {
  if (settings.pauseUntil !== null && settings.pauseUntil > now.getTime()) return "paused";
  return inQuietHours(settings.quietHours, now) ? "quiet-hours" : null;
}

export function quietEndsAt(quiet: QuietHours, now: Date): Date | null {
  if (!inQuietHours(quiet, now)) return null;
  const end = parseClock(quiet.end);
  if (end === null) return null;
  const at = new Date(now);
  at.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

export interface Mute {
  reason: MuteReason;
  until: Date | null;
}

export function currentMute(
  settings: { quietHours: QuietHours; pauseUntil: number | null },
  now: Date,
): Mute | null {
  const reason = muteReason(settings, now);
  if (reason === "paused" && settings.pauseUntil !== null)
    return { reason, until: new Date(settings.pauseUntil) };
  const until = reason === "quiet-hours" ? quietEndsAt(settings.quietHours, now) : null;
  return reason && until ? { reason, until } : null;
}
