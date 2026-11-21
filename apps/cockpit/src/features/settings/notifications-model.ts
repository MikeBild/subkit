import type { SetupUpdate } from "@/api/setup";
import {
  DEFAULT_WORKING_DAYS,
  isClock,
  questionError,
  questionUpdate,
  type SetupAnswers,
} from "@/features/setup";
import type { TranslationKey } from "@/lib/i18n";

export interface NotificationView {
  quiet: boolean;
  quietFrom: string;
  quietUntil: string;
  days: number[];
  digest: boolean;
  digestAt: string;
  scheduled: boolean;
  critical: boolean;
  timezone: string | null;
}

export interface NotificationChange {
  quiet?: boolean;
  quietFrom?: string;
  quietUntil?: string;
  days?: number[];
  digest?: boolean;
  digestAt?: string;
  critical?: boolean;
  timezone?: string;
}

export const QUIET_DEFAULT = { from: "18:00", until: "08:00" } as const;

export function notificationView(answers: SetupAnswers): NotificationView {
  const quiet = answers.notify === "working_hours";
  return {
    quiet,
    quietFrom: quiet ? answers.to : QUIET_DEFAULT.from,
    quietUntil: quiet ? answers.from : QUIET_DEFAULT.until,
    days: quiet ? answers.days : [...DEFAULT_WORKING_DAYS],
    digest: answers.notify === "daily_digest",
    digestAt: answers.at,
    scheduled: answers.notify !== "immediately",
    critical: answers.critical,
    timezone: answers.timezone,
  };
}

function nextAnswers(answers: SetupAnswers, change: NotificationChange): SetupAnswers {
  const view = notificationView(answers);
  const next: SetupAnswers = { ...answers };
  if (change.quiet !== undefined)
    Object.assign(
      next,
      change.quiet
        ? { notify: "working_hours", from: view.quietUntil, to: view.quietFrom, days: view.days }
        : { notify: "immediately" },
    );
  if (change.digest !== undefined) next.notify = change.digest ? "daily_digest" : "immediately";
  if (change.quietFrom !== undefined) next.to = change.quietFrom;
  if (change.quietUntil !== undefined) next.from = change.quietUntil;
  if (change.days !== undefined) next.days = change.days;
  if (change.digestAt !== undefined) next.at = change.digestAt;
  if (change.critical !== undefined) next.critical = change.critical;
  if (change.timezone !== undefined) next.timezone = change.timezone;
  return next;
}

export function notificationChange(
  answers: SetupAnswers,
  change: NotificationChange,
): { answers: SetupAnswers; update: SetupUpdate | null; error: TranslationKey | null } {
  const next = nextAnswers(answers, change);
  const error = questionError("notify", next);
  return { answers: next, update: error ? null : questionUpdate("notify", next), error };
}

function minutes(clock: string): number {
  const [h = "0", m = "0"] = clock.split(":");
  return Number(h) * 60 + Number(m);
}

function localClock(now: Date, timezone: string): { minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(read("weekday")) + 1;
  return { minute: Number(read("hour")) * 60 + Number(read("minute")), weekday };
}

export function quietNow(view: NotificationView, now: Date, timezone: string): boolean {
  if (!view.quiet) return false;
  const { minute, weekday } = localClock(now, view.timezone ?? timezone);
  const open = minutes(view.quietUntil);
  const close = minutes(view.quietFrom);
  const yesterday = weekday === 1 ? 7 : weekday - 1;
  if (open === close) return !view.days.includes(weekday);
  if (open < close) return !view.days.includes(weekday) || minute < open || minute >= close;
  if (minute >= open) return !view.days.includes(weekday);
  if (minute < close) return !view.days.includes(yesterday);
  return true;
}

export interface TerminalQuiet {
  from: string;
  until: string;
}

export function terminalQuietError(value: TerminalQuiet): TranslationKey | null {
  const empty = value.from === "" && value.until === "";
  if (empty) return null;
  return isClock(value.from) && isClock(value.until) ? null : "setup.timeError";
}

export interface ApproverState {
  kind: string;
  email?: string;
  invitation?: string;
  can_approve?: boolean | null;
}

export function approvalsTo(approver: ApproverState, me: string): string {
  const delegated =
    approver.kind === "teammate" &&
    Boolean(approver.email) &&
    approver.invitation === "member" &&
    approver.can_approve !== false;
  return delegated && approver.email ? approver.email : me;
}
