import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  settingsPersonalDe,
  settingsPersonalEn,
} from "../../apps/cockpit/src/lib/i18n/settings-personal.ts";
import { setupDe, setupEn } from "../../apps/cockpit/src/lib/i18n/setup.ts";

const guideDir = join(import.meta.dir, "../../apps/engine/src/http/reference");
const readGuide = (locale: string) =>
  readFileSync(join(guideDir, `notifications-and-quiet-hours.${locale}.md`), "utf8");
const sectionOf = (guide: string, heading: RegExp) =>
  guide.split(/^### /m).find((section) => heading.test(section.split("\n")[0] ?? "")) ?? "";
const setupLinePrefix = (title: string) => title.split(":")[0]?.replace(/^\S+ /, "") ?? title;

const locales = [
  { locale: "en", setup: setupEn, settings: settingsPersonalEn, limits: /^Limits$/ },
  { locale: "de", setup: setupDe, settings: settingsPersonalDe, limits: /^Grenzen$/ },
];

describe("notifications guide matches the released Cockpit controls (#532)", () => {
  for (const { locale, setup, settings, limits } of locales) {
    const guide = readGuide(locale);
    const zoneSection = sectionOf(guide, new RegExp(setup["setup.zone"], "i"));
    const limitsSection = sectionOf(guide, limits);

    test(`${locale}: no unrendered setup line or open-setup link`, () => {
      expect(guide).not.toContain(setup["setup.openSetup"]);
      expect(guide).not.toContain(setupLinePrefix(setup["setup.schedule.title"]));
    });

    test(`${locale}: own time zone points to the Cockpit field`, () => {
      expect(zoneSection).toContain(`**${setup["setup.zone"]}**`);
      expect(zoneSection).toContain(settings["settings.notifications.more"]);
    });

    test(`${locale}: limits no longer claim critical breakthrough is API-only`, () => {
      expect(limitsSection).not.toContain("critical_breakthrough");
    });

    test(`${locale}: names the real control labels`, () => {
      for (const label of [
        setup["setup.critical"],
        setup["setup.label.daily"],
        settings["settings.notifications.quiet"],
        settings["settings.notifications.days"],
      ])
        expect(guide).toContain(`**${label}**`);
    });
  }
});
