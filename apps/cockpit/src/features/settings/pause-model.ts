import { type NotificationPauseBody, pauseState } from "@shared/notification-pause.ts";
import type { PauseRequest } from "@/api/notification-pause";
import type { TranslationKey } from "@/lib/i18n";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export const PAUSE_OPTIONS = ["hour", "tomorrow", "resumed"] as const;
export type PauseOption = (typeof PAUSE_OPTIONS)[number];

export const PAUSE_OPTION_KEYS: Record<PauseOption, TranslationKey> = {
  hour: "pause.option.hour",
  tomorrow: "pause.option.tomorrow",
  resumed: "pause.option.resumed",
};

const MORNING_HOUR = 8;

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function wallClock(at: number, timezone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
  };
}

function offsetAt(at: number, timezone: string): number {
  const clock = wallClock(at, timezone);
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);
  return asUtc - Math.floor(at / 60_000) * 60_000;
}

export function tomorrowAt(now: number, timezone: string, hour = MORNING_HOUR): number {
  const today = wallClock(now, timezone);
  const wanted = Date.UTC(today.year, today.month - 1, today.day + 1, hour, 0);
  const first = wanted - offsetAt(wanted, timezone);
  return wanted - offsetAt(first, timezone);
}

export function pauseRequest(option: PauseOption, now: number, timezone: string): PauseRequest {
  if (option === "hour") return { mode: "for", minutes: 60 };
  if (option === "tomorrow")
    return { mode: "until", until: new Date(tomorrowAt(now, timezone)).toISOString() };
  return { mode: "until_resumed" };
}

function sameDay(a: number, b: number, timezone: string): boolean {
  const x = wallClock(a, timezone);
  const y = wallClock(b, timezone);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

export function pauseLabel(
  body: NotificationPauseBody | null | undefined,
  now: number,
  timezone: string,
  locale: string,
  t: Translate,
): string | null {
  const state = pauseState(body, now);
  if (state.kind === "off") return null;
  if (state.kind === "until_resumed") return t("pause.untilResumed");
  const time = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(state.until));
  if (sameDay(state.until, now, timezone)) return t("pause.until", { time });
  const day = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(state.until));
  return t("pause.untilDay", { day, time });
}
