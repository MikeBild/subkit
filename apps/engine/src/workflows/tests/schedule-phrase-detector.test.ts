import { describe, expect, it } from "bun:test";
import { detectSchedulePhrases } from "../schedule-phrase-detector.ts";

describe("detectSchedulePhrases", () => {
  it("matches 'every day at 7pm'", () => {
    const v = detectSchedulePhrases({ description: "Send the report every day at 7pm" });
    expect(v.matched).toBe(true);
    expect(v.matched_phrases).toContain("every-day-at-HH");
  });

  it("matches 'daily at 9am'", () => {
    const v = detectSchedulePhrases({ description: "Run the job daily at 9am" });
    expect(v.matched).toBe(true);
    expect(v.matched_phrases).toContain("daily-at-HH");
  });

  it("matches 'hourly'", () => {
    const v = detectSchedulePhrases({ description: "Hourly sync from CRM" });
    expect(v.matched).toBe(true);
    expect(v.matched_phrases).toContain("hourly");
  });

  it("matches 'every 10 minutes'", () => {
    const v = detectSchedulePhrases({ description: "Poll the API every 10 minutes" });
    expect(v.matched).toBe(true);
    expect(v.matched_phrases).toContain("every-N-minutes");
  });

  it("matches 'every Monday morning'", () => {
    const v = detectSchedulePhrases({ description: "Email the team every Monday morning" });
    expect(v.matched).toBe(true);
    expect(v.matched_phrases).toContain("every-weekday-at-HH");
  });

  it("matches 'täglich um 18 Uhr'", () => {
    const v = detectSchedulePhrases({ description: "Sende täglich um 18 Uhr eine E-Mail" });
    expect(v.matched).toBe(true);
    expect(v.matched_phrases).toContain("täglich");
  });

  it("matches 'stündlich'", () => {
    const v = detectSchedulePhrases({ description: "Stündlich aktualisieren" });
    expect(v.matched).toBe(true);
    expect(v.matched_phrases).toContain("stündlich");
  });

  it("matches 'alle 10 Minuten'", () => {
    const v = detectSchedulePhrases({ description: "Alle 10 Minuten prüfen" });
    expect(v.matched).toBe(true);
    expect(v.matched_phrases).toContain("alle-N-minuten");
  });

  it("does NOT match 'every step should retry'", () => {
    const v = detectSchedulePhrases({
      description: "Every step should retry on transient failures",
    });
    expect(v.matched).toBe(false);
  });

  it("does NOT match 'send a webhook every time stripe charges fail'", () => {
    const v = detectSchedulePhrases({
      description: "Send a webhook every time stripe charges fail",
    });
    expect(v.matched).toBe(false);
  });

  it("does NOT match 'the workflow runs in production'", () => {
    const v = detectSchedulePhrases({ description: "The workflow runs in production" });
    expect(v.matched).toBe(false);
  });

  it("does NOT match empty input", () => {
    expect(detectSchedulePhrases({ name: "", description: "" }).matched).toBe(false);
    expect(detectSchedulePhrases({}).matched).toBe(false);
  });

  it("returns multiple matches when present", () => {
    const v = detectSchedulePhrases({
      description: "Run daily at 9am and again every 10 minutes",
    });
    expect(v.matched).toBe(true);
    expect(v.matched_phrases).toContain("daily-at-HH");
    expect(v.matched_phrases).toContain("every-N-minutes");
  });
});
