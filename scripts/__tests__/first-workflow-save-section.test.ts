import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatDe, chatEn } from "../../apps/cockpit/src/lib/i18n/chat.ts";
import { setupDe, setupEn } from "../../apps/cockpit/src/lib/i18n/setup.ts";
import { commitGateBypassed } from "../../apps/engine/src/conversations/persistence/commit-workflow.ts";

const guideDir = join(import.meta.dir, "../../apps/engine/src/http/reference");

const sectionContaining = (locale: string, marker: string) => {
  const guide = readFileSync(join(guideDir, `first-workflow.${locale}.md`), "utf8");
  return guide.split(/\n(?=### )/).find((section) => section.includes(marker)) ?? "";
};

const locales = [
  { locale: "en", chat: chatEn, setup: setupEn },
  { locale: "de", chat: chatDe, setup: setupDe },
];

describe("first workflow save section matches the default commit gate (#633)", () => {
  test("an inactive draft saves without approval unless ask_before_writing is on", () => {
    expect(commitGateBypassed({ ask_before_writing: false })).toBe(true);
    expect(commitGateBypassed({})).toBe(true);
    expect(commitGateBypassed({ ask_before_writing: true })).toBe(false);
  });

  for (const { locale, chat, setup } of locales) {
    const saveButton = `**${chat["chat.decision.save"]}**`;
    const card = `**${chat["chat.decision.saveTitle"]}**`;
    const askFirst = `**${setup["rules.askFirst.label"]}**`;
    const section = sectionContaining(locale, saveButton);
    const paragraphs = section.split(/\n\s*\n/).slice(1);

    test(`${locale}: the default save is described before and without the card`, () => {
      expect(paragraphs.length).toBeGreaterThan(0);
      expect(paragraphs[0]).not.toContain(card);
      expect(paragraphs[0]).not.toContain(askFirst);
      expect(paragraphs[0]).toContain("**Workflows**");
    });

    test(`${locale}: the save card only appears with ${askFirst}`, () => {
      const cardLines = section.split("\n").filter((line) => line.includes(card));
      expect(cardLines.length).toBeGreaterThan(0);
      for (const line of cardLines) expect(line).toContain(askFirst);
      expect(section).toContain(`**${chat["chat.decision.details"]}**`);
      expect(section).toContain("(setup.md#");
    });
  }
});
