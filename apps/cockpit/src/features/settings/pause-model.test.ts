import { describe, expect, test } from "bun:test";
import { type TranslationKey, translate } from "@/lib/i18n";
import { pauseLabel, pauseRequest, tomorrowAt } from "./pause-model";

const de = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);
const en = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);

const NOW = Date.parse("2026-11-21T14:05:00.000Z");

describe("personal notification pause", () => {
  test("tomorrow 8:00 is read in the person's zone, also across a clock change", () => {
    expect(new Date(tomorrowAt(NOW, "Europe/Berlin")).toISOString()).toBe(
      "2026-11-22T07:00:00.000Z",
    );
    expect(new Date(tomorrowAt(NOW, "America/New_York")).toISOString()).toBe(
      "2026-11-22T13:00:00.000Z",
    );
    expect(
      new Date(tomorrowAt(Date.parse("2026-11-21T23:30:00.000Z"), "Europe/Berlin")).toISOString(),
    ).toBe("2026-11-23T07:00:00.000Z");
    expect(
      new Date(tomorrowAt(Date.parse("2026-03-28T12:00:00.000Z"), "Europe/Berlin")).toISOString(),
    ).toBe("2026-03-29T06:00:00.000Z");
  });

  test("each option becomes the matching request", () => {
    expect(pauseRequest("hour", NOW, "Europe/Berlin")).toEqual({ mode: "for", minutes: 60 });
    expect(pauseRequest("tomorrow", NOW, "Europe/Berlin")).toEqual({
      mode: "until",
      until: "2026-11-22T07:00:00.000Z",
    });
    expect(pauseRequest("resumed", NOW, "Europe/Berlin")).toEqual({ mode: "until_resumed" });
  });

  test("the label uses the same terms as the desktop tray", () => {
    const zone = "Europe/Berlin";
    expect(pauseLabel(null, NOW, zone, "de-DE", de)).toBeNull();
    expect(
      pauseLabel(
        { paused: true, mode: "until", paused_at: null, until: "2026-11-21T15:05:00.000Z" },
        NOW,
        zone,
        "de-DE",
        de,
      ),
    ).toBe("Pausiert bis 16:05 Uhr");
    expect(
      pauseLabel(
        { paused: true, mode: "until", paused_at: null, until: "2026-11-22T07:00:00.000Z" },
        NOW,
        zone,
        "de-DE",
        de,
      ),
    ).toBe("Pausiert bis So. 22.11., 08:00 Uhr");
    expect(
      pauseLabel(
        { paused: true, mode: "until_resumed", paused_at: null, until: null },
        NOW,
        zone,
        "de-DE",
        de,
      ),
    ).toBe("Pausiert bis zum Fortsetzen");
    expect(
      pauseLabel(
        { paused: true, mode: "until_resumed", paused_at: null, until: null },
        NOW,
        zone,
        "en-US",
        en,
      ),
    ).toBe("Paused until resumed");
  });

  test("a pause whose time has run out reads as off", () => {
    expect(
      pauseLabel(
        { paused: true, mode: "until", paused_at: null, until: "2026-11-21T14:00:00.000Z" },
        NOW,
        "Europe/Berlin",
        "de-DE",
        de,
      ),
    ).toBeNull();
  });
});
