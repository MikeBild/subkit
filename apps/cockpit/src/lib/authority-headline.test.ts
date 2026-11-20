import { describe, expect, test } from "bun:test";
import { type Locale, translate } from "@/lib/i18n";
import { authorityHeadline, authorityVersionLabel } from "./workflow-authorities";

const tr =
  (locale: Locale) =>
  (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate(locale, key, values);

const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("authority headline", () => {
  const until = new Date(Date.UTC(2026, 8, 28, 16, 0)).toISOString();
  const now = Date.UTC(2026, 8, 20, 9, 0);
  const zone = "Europe/Berlin";

  test("says where, until when (with its zone) and how often — in German", () => {
    expect(
      authorityHeadline(
        { execution_environment: "prod", valid_until: until, max_runs: 24 },
        tr("de"),
        "de",
        now,
        zone,
      ),
    ).toBe("Echtbetrieb · gültig bis 28.09., 18:00 MESZ · bis zu 24 Läufe");
  });

  test("an approval until revoked says so instead of a date and a count", () => {
    expect(
      authorityHeadline(
        { execution_environment: "prod", valid_until: null, max_runs: null },
        tr("de"),
        "de",
        now,
        zone,
      ),
    ).toBe("Echtbetrieb · bis auf Widerruf · unbegrenzte Läufe");
  });

  test("names the year when the end is not this year", () => {
    const nextYear = new Date(Date.UTC(2027, 0, 5, 11, 0)).toISOString();
    expect(
      authorityHeadline(
        { execution_environment: "prod", valid_until: nextYear, max_runs: 2 },
        tr("de"),
        "de",
        now,
        zone,
      ),
    ).toBe("Echtbetrieb · gültig bis 05.01.2027, 12:00 MEZ · bis zu 2 Läufe");
  });

  test("one run is singular", () => {
    expect(
      authorityHeadline(
        { execution_environment: "dev", valid_until: until, max_runs: 1 },
        tr("de"),
        "de",
        now,
        zone,
      ),
    ).toBe("Test · gültig bis 28.09., 18:00 MESZ · bis zu 1 Lauf");
    expect(
      authorityHeadline(
        { execution_environment: "dev", valid_until: until, max_runs: 1 },
        tr("en"),
        "en",
        now,
        zone,
      ),
    ).toMatch(/^Test · valid until .+ · up to 1 run$/);
  });

  test("an unreadable end drops that part rather than printing 'Invalid Date'", () => {
    expect(
      authorityHeadline(
        { execution_environment: "prod", valid_until: "not-a-date", max_runs: 3 },
        tr("de"),
        "de",
        now,
        zone,
      ),
    ).toBe("Echtbetrieb · bis zu 3 Läufe");
  });
});

describe("authority version label", () => {
  const running = "8a3d5f7b-1c9e-4d26-a0b8-f4e6c2d1a9b3";
  const other = "3f6b9d2c-8e1a-4b75-9c40-a2d5e7f1b3c8";
  const versions = new Map([[running, 8]]);

  test("a version the page can number reads v{n}, the id on the title", () => {
    expect(authorityVersionLabel(running, versions)).toEqual({ text: "v8", full: running });
  });

  test("any other version is shortened, never printed whole", () => {
    const label = authorityVersionLabel(other, versions);
    expect(label.text).not.toMatch(UUID_SHAPE);
    expect(label.full).toBe(other);
  });
});
