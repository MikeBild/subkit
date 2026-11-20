import { describe, expect, test } from "bun:test";
import { CATALOGS, type TranslationKey } from "@/lib/i18n";
import { taskGrantDe, taskGrantEn } from "@/lib/i18n/task-grant";

const keys = Object.keys(taskGrantEn) as Array<keyof typeof taskGrantEn>;
const sentences = (text: string) =>
  text.split(/(?<=[.?…])\s+(?=\p{Lu}|[„“])/u).filter((part) => part.trim().length > 0);

describe("the copy of the standing permission", () => {
  test("is registered in both languages", () => {
    for (const key of keys) {
      expect(CATALOGS.en[key]).toBe(taskGrantEn[key]);
      expect(CATALOGS.de[key]).toBe(taskGrantDe[key]);
    }
  });

  test("says one sentence per message and never shouts", () => {
    for (const key of keys)
      for (const text of [taskGrantEn[key], taskGrantDe[key]]) {
        expect(sentences(text).length, `${key}: ${text}`).toBe(1);
        expect(text, key).not.toContain("!");
      }
  });

  test("uses each language's own quotation marks and no technical words", () => {
    const technical =
      /\b(dev|prod|environment|umgebung|cron|fingerprint|fingerabdruck|grant|boundary|tenant|mandant|principal|turn)\b/i;
    for (const key of keys) {
      expect(taskGrantEn[key], key).not.toMatch(/["'„]/);
      expect(taskGrantDe[key], key).not.toMatch(/["'”]/);
      expect(taskGrantDe[key], key).not.toMatch(/\b(Ihnen|Ihre?[nmrs]?)\b/);
      expect(taskGrantEn[key], key).not.toMatch(technical);
      expect(taskGrantDe[key], key).not.toMatch(technical);
    }
  });

  test("uses the agreed words for the actions and the standing permission", () => {
    expect([taskGrantDe["taskGrant.allow"], taskGrantEn["taskGrant.allow"]]).toEqual([
      "Erlauben",
      "Allow",
    ]);
    expect([taskGrantDe["taskPermissions.revoke"], taskGrantEn["taskPermissions.revoke"]]).toEqual([
      "Widerrufen",
      "Revoke",
    ]);
    expect(taskGrantDe["taskPermissions.summary.untilRevoked"]).toContain("Dauererlaubnis");
    expect(taskGrantEn["taskPermissions.summary.untilRevoked"]).toContain("standing permission");
  });
});

describe("what a trial run is", () => {
  test("is said in one sentence in both languages", () => {
    const key: TranslationKey = "authority.trial.what";
    for (const text of [CATALOGS.en[key], CATALOGS.de[key]]) {
      expect(sentences(text).length, text).toBe(1);
      expect(text).toMatch(/holds back every write|hält jeden Schreibzugriff zurück/);
    }
  });
});
