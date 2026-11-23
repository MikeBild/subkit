import type { TranslationKey } from "@/lib/i18n";
import type { AttentionItem } from "../api/attention-contract";

export const SNOOZE_CHOICES = ["three_hours", "tomorrow", "next_week"] as const;
export type SnoozeChoice = (typeof SNOOZE_CHOICES)[number];

export const SNOOZE_CHOICE_KEYS: Record<SnoozeChoice, TranslationKey> = {
  three_hours: "overview.snooze.threeHours",
  tomorrow: "overview.snooze.tomorrow",
  next_week: "overview.snooze.nextWeek",
};

const HOUR_MS = 3_600_000;
const MORNING_HOUR = 8;

export function attentionSnoozeKey(item: Pick<AttentionItem, "id" | "class" | "reason">): string {
  return `${item.id}|${item.class}|${item.reason}`;
}

function morningAfter(now: Date, days: number): Date {
  const morning = new Date(now.getTime());
  morning.setDate(morning.getDate() + days);
  morning.setHours(MORNING_HOUR, 0, 0, 0);
  return morning;
}

export function snoozeUntil(choice: SnoozeChoice, now: Date): Date {
  if (choice === "three_hours") return new Date(now.getTime() + 3 * HOUR_MS);
  return morningAfter(now, choice === "tomorrow" ? 1 : 7);
}
