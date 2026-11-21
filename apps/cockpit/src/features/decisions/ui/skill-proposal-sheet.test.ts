import { describe, expect, test } from "bun:test";
import { uiDicts } from "@ui/lib/ui-context";
import { type Locale, type TranslationKey, translate } from "@/lib/i18n";

const t = (locale: Locale) => (key: TranslationKey, values?: Record<string, string | number>) =>
  translate(locale, key, values);

describe("discarding a skill proposal", () => {
  test("asks about the proposal, not the skill name", () => {
    for (const [locale, title] of [
      ["de", "Vorschlag verwerfen?"],
      ["en", "Discard proposal?"],
    ] as const) {
      const say = t(locale);
      expect(
        uiDicts[locale].confirm.title(say("skills.proposalObject"), say("skills.reject")),
      ).toBe(title);
    }
  });

  test("says that discarding is final", () => {
    expect(t("de")("skills.rejectConsequence", { name: "Kundenpflege" })).toBe(
      "„Kundenpflege“ wird nicht übernommen, und SubKit schlägt ihn nicht noch einmal vor.",
    );
    expect(t("en")("skills.rejectConsequence", { name: "Customer care" })).toBe(
      "“Customer care” is not applied, and SubKit will not propose it again.",
    );
    expect(t("de")("decisions.noteScopeFinal")).toContain("nicht noch einmal vor");
  });
});
