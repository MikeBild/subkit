import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { knDe, knEn } from "../../apps/cockpit/src/lib/i18n/kn.ts";
import { germanTextLines } from "../../apps/engine/scripts/audit/german-text.ts";

const guideDir = join(import.meta.dir, "../../apps/engine/src/http/reference");
const readGuide = (locale: string) =>
  readFileSync(join(guideDir, `maintain-sources-skills-and-files.${locale}.md`), "utf8");
const englishHeadings = readGuide("en")
  .split(/^### /m)
  .map((section) => section.split("\n")[0]);
const sectionOf = (guide: string, heading: string) =>
  guide.split(/^### /m)[englishHeadings.indexOf(heading)] ?? "";

const locales = [
  { locale: "en", kn: knEn },
  { locale: "de", kn: knDe },
];

test("file restore guide test contains no German text outside locale catalogs", () => {
  expect(germanTextLines(readFileSync(import.meta.path, "utf8"))).toEqual([]);
});

describe("file restore guide matches the Cockpit versions tab (#549)", () => {
  for (const { locale, kn } of locales) {
    const guide = readGuide(locale);
    const restoreSection = sectionOf(guide, "Restore an earlier state of a file");
    const troubleSection = sectionOf(guide, "If something does not work");

    test(`${locale}: restore steps name the versions tab and restore button`, () => {
      expect(restoreSection).toContain(`**${kn["kn.tab.versions"]}**`);
      expect(restoreSection).toContain(`**${kn["kn.restore"]}**`);
    });

    test(`${locale}: no replaced section under the usage tab`, () => {
      expect(restoreSection).not.toContain(`**${kn["kn.tab.usage"]}**`);
      expect(restoreSection).not.toContain(`**${kn["kn.files.replacedAt"]}**`);
      expect(troubleSection).not.toContain(`**${kn["kn.files.replacedAt"]}**`);
      expect(troubleSection).toContain(`**${kn["kn.tab.versions"]}**`);
    });
  }
});
