export type Rhythm = "daily" | "weekly" | "monthly";

export interface RhythmValue {
  rhythm: Rhythm;
  weekday: number;
  time: string;
}

export const DEFAULT_RHYTHM: RhythmValue = { rhythm: "daily", weekday: 1, time: "08:00" };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validTime(time: string): boolean {
  return TIME.test(time);
}

export function rhythmToCron(value: RhythmValue): string {
  const match = TIME.exec(value.time);
  if (!match) throw new Error(`invalid time: ${value.time}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (value.rhythm === "weekly") return `${minute} ${hour} * * ${value.weekday}`;
  if (value.rhythm === "monthly") return `${minute} ${hour} 1 * *`;
  return `${minute} ${hour} * * *`;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function cronToRhythm(cron: string): RhythmValue | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || month !== "*") return null;
  const m = Number(minute);
  const h = Number(hour);
  if (m > 59 || h > 23) return null;
  const time = `${pad(h)}:${pad(m)}`;
  if (day === "*" && weekday === "*") return { rhythm: "daily", weekday: 1, time };
  if (day === "*" && /^[0-7]$/.test(weekday))
    return { rhythm: "weekly", weekday: Number(weekday) % 7, time };
  if (day === "1" && weekday === "*") return { rhythm: "monthly", weekday: 1, time };
  return null;
}
