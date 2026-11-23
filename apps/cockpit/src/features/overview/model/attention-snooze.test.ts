import { expect, test } from "bun:test";
import {
  attentionSnoozeKey,
  SNOOZE_CHOICE_KEYS,
  SNOOZE_CHOICES,
  snoozeUntil,
} from "./attention-snooze";

const now = new Date(2026, 10, 23, 15, 30, 0, 0);

test("the snooze key names id, class and reason the way the engine does", () => {
  expect(attentionSnoozeKey({ id: "workflow:1", class: "stopped", reason: "input_required" })).toBe(
    "workflow:1|stopped|input_required",
  );
});

test("three hours ends three hours from now", () => {
  expect(snoozeUntil("three_hours", now)).toEqual(new Date(2026, 10, 23, 18, 30, 0, 0));
});

test("tomorrow ends the next morning at eight, local time", () => {
  expect(snoozeUntil("tomorrow", now)).toEqual(new Date(2026, 10, 24, 8, 0, 0, 0));
});

test("next week ends seven days on at eight, across a month end", () => {
  expect(snoozeUntil("next_week", new Date(2026, 10, 27, 23, 59, 0, 0))).toEqual(
    new Date(2026, 11, 4, 8, 0, 0, 0),
  );
});

test("every choice ends in the future and has a label", () => {
  for (const choice of SNOOZE_CHOICES) {
    expect(snoozeUntil(choice, now).getTime()).toBeGreaterThan(now.getTime());
    expect(SNOOZE_CHOICE_KEYS[choice]).toStartWith("overview.snooze.");
  }
});
