import { describe, expect, test } from "bun:test";
import { cronWords } from "@/features/workflows/model/cron-words";
import { LOCALE_TAGS, translate } from "@/lib/i18n";

const de = (cron: string) =>
  cronWords(cron, (key, values) => translate("de", key, values), LOCALE_TAGS.de);
const en = (cron: string) =>
  cronWords(cron, (key, values) => translate("en", key, values), LOCALE_TAGS.en);

describe("cronWords", () => {
  test.each([
    ["0 7 * * *", "täglich um 07:00", "daily at 07:00"],
    ["30 18 * * *", "täglich um 18:30", "daily at 18:30"],
    ["7 * * * *", "stündlich zur Minute 07", "hourly at minute 07"],
    ["*/15 * * * *", "alle 15 Minuten", "every 15 minutes"],
    ["0 */6 * * *", "alle 6 Stunden", "every 6 hours"],
    ["0 9 * * 1-5", "montags bis freitags um 09:00", "Monday to Friday at 09:00"],
    ["0 9 * * 1", "jeden Montag um 09:00", "every Monday at 09:00"],
    ["0 9 * * 0", "jeden Sonntag um 09:00", "every Sunday at 09:00"],
    ["0 9 * * 7", "jeden Sonntag um 09:00", "every Sunday at 09:00"],
    ["0 6 1 * *", "monatlich am 1. um 06:00", "monthly on day 1 at 06:00"],
    ["every:900", "alle 15 Minuten", "every 15 minutes"],
    ["every:7200", "alle 2 Stunden", "every 2 hours"],
    ["every:45", "alle 45 Sekunden", "every 45 seconds"],
  ])("%s", (cron, german, english) => {
    expect(de(cron)).toBe(german);
    expect(en(cron)).toBe(english);
  });

  test.each([
    "0 7 * 3 *",
    "0 7 1,15 * *",
    "0 7 * * 1,3",
    "0 7-9 * * *",
    "0 7 1 * 1",
    "@daily",
    "paused-fixture",
    "",
  ])("an expression it does not recognise is returned as it stands: %p", (cron) => {
    expect(de(cron)).toBe(cron);
  });
});
