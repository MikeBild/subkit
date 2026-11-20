import type { AttentionClass } from "../operator/core/attention.ts";
import type { PersonalDelivery } from "./personal-schedule.ts";
import { currentWorkingStart, safeTimeZone } from "./quiet-hours.ts";

export const PUSH_SUMMARY_MIN_ITEMS = 2;

export type PushSummaryMode =
  | { readonly kind: "digest" }
  | { readonly kind: "release"; readonly window_start: Date }
  | null;

export interface PushSummary {
  readonly total: number;
  readonly by_class: Partial<Record<AttentionClass, number>>;
}

const CLASS_ORDER: readonly AttentionClass[] = ["stopped", "failing", "decide"];

export function pushSummaryMode(
  delivery: Pick<PersonalDelivery, "held" | "digest" | "preference">,
  at: Date,
): PushSummaryMode {
  if (delivery.held) return null;
  if (delivery.digest) return { kind: "digest" };
  const schedule = delivery.preference.schedule;
  if (schedule.mode !== "working_hours") return null;
  const start = currentWorkingStart(schedule, at, safeTimeZone(delivery.preference.timezone));
  return start ? { kind: "release", window_start: start } : null;
}

export function summarizesPush(
  mode: PushSummaryMode,
  notified_at: Date | null | undefined,
  fresh: number,
): boolean {
  if (!mode || fresh < PUSH_SUMMARY_MIN_ITEMS) return false;
  if (mode.kind === "digest") return true;
  return !notified_at || notified_at.getTime() < mode.window_start.getTime();
}

export function buildPushSummary(
  items: readonly { readonly class: AttentionClass }[],
): PushSummary {
  const counts = new Map<AttentionClass, number>();
  for (const item of items) counts.set(item.class, (counts.get(item.class) ?? 0) + 1);
  const by_class: Partial<Record<AttentionClass, number>> = {};
  for (const klass of CLASS_ORDER) {
    const count = counts.get(klass);
    if (count) by_class[klass] = count;
  }
  return { total: items.length, by_class };
}

function sinceOf(item: { readonly since: string | null }): number {
  const parsed = item.since === null ? Number.NaN : Date.parse(item.since);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export function newestItem<T extends { readonly since: string | null }>(
  items: readonly T[],
): T | null {
  let newest: T | null = null;
  for (const item of items) if (newest === null || sinceOf(item) > sinceOf(newest)) newest = item;
  return newest;
}
