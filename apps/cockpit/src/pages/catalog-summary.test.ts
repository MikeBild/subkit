import { describe, expect, test } from "bun:test";
import { type TranslationKey, translate } from "@/lib/i18n";
import { catalogCountLine } from "./catalog";

const german = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);
const english = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);

describe("catalog lists open with the same count line as the knowledge lists", () => {
  test("workflows are counted like sources, skills and files", () => {
    expect(catalogCountLine(german, 24)).toBe("24 Workflows");
    expect(catalogCountLine(german, 1)).toBe("1 Workflow");
    expect(translate("de", "knowledge.summary.other", { count: 34 })).toBe("34 Quellen");
  });

  test("the count line reads naturally in English too", () => {
    expect(catalogCountLine(english, 1)).toBe("1 workflow");
    expect(catalogCountLine(english, 3)).toBe("3 workflows");
  });
});
