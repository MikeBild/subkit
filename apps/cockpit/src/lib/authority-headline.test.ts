import { describe, expect, test } from "bun:test";
import { type Locale, translate } from "@/lib/i18n";
import { authorityHeadline, authorityVersionLabel } from "./workflow-authorities";

const tr =
  (locale: Locale) =>
  (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate(locale, key, values);

const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("authority headline", () => {
  // 18:00 local time, whatever the machine's zone: the headline is local.
  const until = new Date(2026, 8, 28, 18, 0).toISOString();

  test("says where, until when and how often — in German", () => {
    expect(
      authorityHeadline(
        { execution_environment: "prod", valid_until: until, max_runs: 24 },
        tr("de"),
        "de",
      ),
    ).toBe("Produktion · gültig bis 28.09., 18:00 · bis zu 24 Läufe");
  });

  test("one run is singular", () => {
    expect(
      authorityHeadline(
        { execution_environment: "dev", valid_until: until, max_runs: 1 },
        tr("de"),
        "de",
      ),
    ).toBe("Entwicklung · gültig bis 28.09., 18:00 · bis zu 1 Lauf");
    expect(
      authorityHeadline(
        { execution_environment: "dev", valid_until: until, max_runs: 1 },
        tr("en"),
        "en",
      ),
    ).toMatch(/^Development · valid until .+ · up to 1 run$/);
  });

  test("an unreadable end drops that part rather than printing 'Invalid Date'", () => {
    expect(
      authorityHeadline(
        { execution_environment: "prod", valid_until: "not-a-date", max_runs: 3 },
        tr("de"),
        "de",
      ),
    ).toBe("Produktion · bis zu 3 Läufe");
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
