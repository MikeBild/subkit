import { describe, expect, test } from "bun:test";
import { CATALOGS, LOCALES, pluralKey, translatePlural } from "@/lib/i18n";

describe("counted copy", () => {
  test("one reads singular and every other count reads plural", () => {
    expect(translatePlural("de", "connectors.usedByCount", 1)).toBe("1 Workflow");
    expect(translatePlural("de", "connectors.usedByCount", 2)).toBe("2 Workflows");
    expect(translatePlural("de", "connectors.usedByCount", 0)).toBe("0 Workflows");
    expect(translatePlural("en", "notifications.summary.rules", 1)).toBe("1 rule");
    expect(translatePlural("de", "notifications.summary.channels", 1)).toBe("1 Kanal");
    expect(translatePlural("de", "notifications.summary.channels", 3)).toBe("3 Kanäle");
  });

  test("a large count is written the way the language writes numbers", () => {
    expect(translatePlural("de", "files.summaryCount", 1200)).toBe("1.200 Dateien");
    expect(translatePlural("en", "files.summaryCount", 1200)).toBe("1,200 files");
  });

  test("the key of a count names its form", () => {
    expect(pluralKey("cron.everyHours", 1)).toBe("cron.everyHours.one");
    expect(pluralKey("cron.everyHours", 4)).toBe("cron.everyHours.other");
  });

  test("no copy leaves the plural to the reader", () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(CATALOGS[locale])) {
        if (/\{count\}/.test(value))
          expect(`${key}: ${value}`).not.toMatch(/[a-zäöü]\((s|e|en|n)\)/);
      }
    }
  });
});
