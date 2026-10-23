import { describe, expect, test } from "bun:test";
import { confirmTitle } from "@/components/cockpit/patterns";
import { type Locale, translate } from "@/lib/i18n";

function wording(locale: Locale) {
  const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate(locale, key, values);
  return {
    title: confirmTitle(
      t,
      locale,
      t("knowledge.versions.confirmObject"),
      t("knowledge.versions.confirmVerb"),
    ),
    consequence: t("knowledge.versions.confirmConsequence"),
    confirm: t("knowledge.versions.confirmVerb"),
  };
}

describe("restoring a version asks first", () => {
  test("German follows the prototype", () => {
    expect(wording("de")).toEqual({
      title: "Diese Version wiederherstellen?",
      consequence: "Sie wird als neue Version gespeichert.",
      confirm: "Wiederherstellen",
    });
  });

  test("English says the same", () => {
    expect(wording("en")).toEqual({
      title: "Restore this version?",
      consequence: "It is saved as a new version.",
      confirm: "Restore",
    });
  });
});
