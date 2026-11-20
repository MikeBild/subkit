export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: false, start: "22:00", end: "07:00" };

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseClock(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = CLOCK.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

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
