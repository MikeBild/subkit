import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workflowDe, workflowEn } from "../../apps/cockpit/src/lib/i18n/workflow.ts";

const guideDir = join(import.meta.dir, "../../apps/engine/src/http/reference");
const guideFiles = readdirSync(guideDir).filter((file) => file.endsWith(".md"));
const readGuide = (file: string) => readFileSync(join(guideDir, file), "utf8");

const locales = [
  { locale: "en", labels: workflowEn, tabWord: "tab" },
  { locale: "de", labels: workflowDe, tabWord: "Tab" },
];

describe("guides place workflow approvals under Overview (#570)", () => {
  for (const { locale, labels, tabWord } of locales) {
    const approvals = labels["workflowPage.tab.approvals"];
    const overview = labels["workflowPage.tab.overview"];
    const tabPhrases = [
      new RegExp(`\\*\\*${approvals}\\*\\* ${tabWord}`, "i"),
      new RegExp(`${tabWord} \\*\\*${approvals}\\*\\*`, "i"),
      new RegExp(`\\*\\*${approvals}\\*\\*-${tabWord}`, "i"),
    ];
    const localeFiles = guideFiles.filter((file) => file.endsWith(`.${locale}.md`));

    test(`${locale}: no guide names an ${approvals} tab`, () => {
      const offending = localeFiles.filter((file) =>
        tabPhrases.some((phrase) => phrase.test(readGuide(file))),
      );
      expect(offending).toEqual([]);
    });

    test(`${locale}: onboarding and first workflow point to ${overview} › ${approvals}`, () => {
      for (const file of [`onboard-an-app.${locale}.md`, `first-workflow.${locale}.md`])
        expect(readGuide(file)).toContain(`**${overview} › ${approvals}**`);
    });
  }
});
