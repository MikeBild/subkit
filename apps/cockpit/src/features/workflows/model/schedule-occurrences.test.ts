import { describe, expect, test } from "bun:test";
import {
  autoPauseFacts,
  autoPauseRemedy,
  groupOccurrencesByDay,
  occurrenceCovers,
  occurrenceSentenceKey,
  occurrenceTone,
} from "@/features/workflows/model/schedule-occurrences";
import { translate } from "@/lib/i18n";

const REASONS = [
  "late_start",
  "merged_missed",
  "calendar_weekend",
  "calendar_skip_date",
  "failure_backoff",
  "repeated_failures",
  "input_required",
  "execution_authority_required",
  "execution_authority_expired",
  "execution_authority_exhausted",
  "execution_authority_revoked",
  "execution_authority_changed",
  "grant_required",
  "grant_expired",
  "previous_run_active",
];

describe("schedule occurrences", () => {
  test("has a plain sentence in both languages for every reason code", () => {
    for (const reason of REASONS) {
      const key = occurrenceSentenceKey({ state: "skipped", reason_code: reason });
      expect(key).toBe(`scheduleHistory.reason.${reason}` as typeof key);
      expect(translate("de", key)).not.toBe(translate("en", key));
      expect(translate("de", key)).not.toContain(reason);
    }
  });

  test("asks to approve a version without an approval and to renew one that ran out", () => {
    const lastSentence = (sentence: string) => sentence.split(". ").at(-1);
    const sentenceOf = (locale: "en" | "de", reason: string) =>
      translate(locale, occurrenceSentenceKey({ state: "held", reason_code: reason }));
    expect(sentenceOf("en", "execution_authority_required")).toContain("Approve it");
    expect(sentenceOf("en", "execution_authority_required")).not.toMatch(/renew|no longer/i);
    expect(sentenceOf("en", "execution_authority_expired")).toContain("Renew it");
    expect(lastSentence(sentenceOf("de", "execution_authority_required"))).toBe(
      lastSentence(sentenceOf("de", "grant_required")),
    );
    expect(lastSentence(sentenceOf("de", "execution_authority_required"))).not.toBe(
      lastSentence(sentenceOf("de", "grant_expired")),
    );
    expect(lastSentence(sentenceOf("de", "execution_authority_expired"))).not.toBe(
      lastSentence(sentenceOf("de", "grant_required")),
    );
  });

  test("falls back to the state for an unknown or missing reason", () => {
    expect(occurrenceSentenceKey({ state: "ran", reason_code: null })).toBe(
      "scheduleHistory.state.ran",
    );
    expect(occurrenceSentenceKey({ state: "held", reason_code: "something_new" })).toBe(
      "scheduleHistory.state.held",
    );
  });

  test("tones a held occurrence as a warning and a late run as information", () => {
    expect(occurrenceTone("ran")).toBe("ok");
    expect(occurrenceTone("ran_late")).toBe("info");
    expect(occurrenceTone("skipped")).toBe("neutral");
    expect(occurrenceTone("held")).toBe("warn");
  });

  test("counts the scheduled times a row stands for", () => {
    expect(occurrenceCovers({ state: "ran", skipped_count: 0 })).toBe(0);
    expect(occurrenceCovers({ state: "ran_late", skipped_count: 3 })).toBe(4);
    expect(occurrenceCovers({ state: "skipped", skipped_count: 1 })).toBe(0);
    expect(occurrenceCovers({ state: "held", skipped_count: 4 })).toBe(4);
  });

  test("a merged late run counts the due time it ran for on top of the ones it stood in for", () => {
    expect(occurrenceCovers({ state: "ran_late", skipped_count: 1 })).toBe(2);
    expect(occurrenceCovers({ state: "ran_late", skipped_count: 2 })).toBe(3);
    expect(occurrenceCovers({ state: "ran_late", skipped_count: 0 })).toBe(0);
  });

  test("groups consecutive occurrences by day", () => {
    const days = groupOccurrencesByDay(
      [
        { due_at: "2026-11-20T09:00:00Z" },
        { due_at: "2026-11-20T08:00:00Z" },
        { due_at: "2026-11-19T09:00:00Z" },
      ],
      (instant) => instant.slice(0, 10),
    );
    expect(days.map((day) => [day.day, day.items.length])).toEqual([
      ["2026-11-20", 2],
      ["2026-11-19", 1],
    ]);
  });

  test("offers renewing the approval only for approval failures", () => {
    expect(autoPauseRemedy({ failure_class: "authority_mismatch" })).toBe("renew_approval");
    expect(autoPauseRemedy({ failure_class: "execution_authority_expired" })).toBe(
      "renew_approval",
    );
    expect(autoPauseRemedy({ failure_class: "timeout" })).toBe("resume");
  });

  test("the pause card carries its technical facts for copying and reporting", () => {
    const facts = autoPauseFacts(
      { id: "sch-1", cron: "30 6 * * 1-5" },
      { failure_class: "timeout", since: "2026-11-20T14:00:00Z" },
      (iso) => `at ${iso}`,
    );
    expect(facts.map(([key, value]) => [translate("de", key), value])).toEqual([
      ["Zeitplan-Kennung", "sch-1"],
      ["Cron-Ausdruck", "30 6 * * 1-5"],
      ["Fehlerklasse", "timeout"],
      ["Pausiert seit", "at 2026-11-20T14:00:00Z"],
    ]);
  });
});
