import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { knDe, knEn } from "../../apps/cockpit/src/lib/i18n/kn.ts";

const guideDir = join(import.meta.dir, "../../apps/engine/src/http/reference");
const readGuide = (locale: string) =>
  readFileSync(join(guideDir, `maintain-sources-skills-and-files.${locale}.md`), "utf8");
const sectionOf = (guide: string, heading: RegExp) =>
  guide.split(/^### /m).find((section) => heading.test(section.split("\n")[0] ?? "")) ?? "";

const locales = [
  {
    locale: "en",
    kn: knEn,
    restoreHeading: /^Restore an earlier state of a file$/,
    troubleHeading: /^If something does not work$/,
    replaced: "Replaced",
  },
  {
    locale: "de",
    kn: knDe,
    restoreHeading: /^Einen früheren Stand einer Datei wiederherstellen$/,
    troubleHeading: /^Wenn etwas nicht klappt$/,
    replaced: "Ersetzt",
  },
];

describe("file restore guide matches the Cockpit versions tab (#549)", () => {
  for (const { locale, kn, restoreHeading, troubleHeading, replaced } of locales) {
    const guide = readGuide(locale);
    const restoreSection = sectionOf(guide, restoreHeading);
    const troubleSection = sectionOf(guide, troubleHeading);

    test(`${locale}: restore steps name the versions tab and restore button`, () => {
      expect(restoreSection).toContain(`**${kn["kn.tab.versions"]}**`);
      expect(restoreSection).toContain(`**${kn["kn.restore"]}**`);
    });

    test(`${locale}: no replaced section under the usage tab`, () => {
      expect(restoreSection).not.toContain(`**${kn["kn.tab.usage"]}**`);
      expect(restoreSection).not.toContain(`**${replaced}**`);
      expect(troubleSection).not.toContain(`**${replaced}**`);
      expect(troubleSection).toContain(`**${kn["kn.tab.versions"]}**`);
    });
  }
});
